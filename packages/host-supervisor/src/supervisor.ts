import { createHash, randomBytes } from 'node:crypto'

import type { HomeSession } from '@deskwork/desktop-contracts/home-session'

import { clearHostOwner, recordHostOwner } from './host-owner.js'

import {
  HostControlError,
  LauncherProtocolSession,
  validateLoopbackSurface,
  type HostToLauncherMessage,
  type LauncherToHostMessage,
  type LoopbackSurface,
} from '@deskwork/desktop-contracts/host-control'

/** Short discriminating digest of a home path, for error messages only. */
function homeDigest(home: string): string {
  return `#${createHash('sha256').update(home).digest('hex').slice(0, 12)}`
}

export type HostBootstrap = Readonly<{
  home: string
  profileName: string
  mode: 'normal' | 'safe'
  capability: string
  leaseGeneration: string
}>

/**
 * A Host child created without boot credentials. The supervisor persists the
 * pending spawn, registers the child's operating-system identity on the home
 * owner record, and only then delivers the bootstrap message.
 */
export interface ManagedHostProcess {
  readonly pid: number
  /** Private channel-handshake nonce; distinct from the recorded process identity. */
  readonly startIdentity: string
  deliverBootstrap(bootstrap: HostBootstrap): void
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void
  terminate(): void
  kill(): void
}

export interface HostProcessFactory {
  spawnWaiting(): Promise<ManagedHostProcess>
}

export type HostSupervisorState =
  'idle' | 'starting' | 'healthy' | 'draining' | 'stopped' | 'failed'

/** The Host's own fatal facts, preserved instead of collapsing to BOOT_FAILED. */
export type HostFatalDetail = Readonly<{
  stage: string
  code: string
  summary: string
  retryable: boolean
}>

/**
 * Carries the Host's fatal envelope detail through to the launcher-side
 * failure classifier instead of flattening it into a bare BOOT_FAILED.
 */
class FatalHostControlError extends HostControlError {
  constructor(
    code: 'BOOT_FAILED',
    message: string,
    readonly fatal: HostFatalDetail,
  ) {
    super(code, message)
    this.name = 'FatalHostControlError'
  }
}

export type HostSupervisorEvent =
  | { kind: 'starting'; pid: number }
  | { kind: 'healthy'; pid: number }
  | { kind: 'crashed'; error: HostControlError }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: HostControlError; fatal?: HostFatalDetail }

export type HostReady = Readonly<{
  pid: number
  startIdentity: string
  surface: LoopbackSurface
  origin: string
}>

export type HostStartRequest = Readonly<{
  home: string
  profileName: string
  mode: 'normal' | 'safe'
  session: HomeSession
  /** The Host entry path recorded so a later run can recognise this Host. */
  argvPin: string
}>

export type HostSupervisorOptions = Readonly<{
  factory: HostProcessFactory
  stabilityMs?: number
  startupTimeoutMs?: number
  terminateGraceMs?: number
  onEvent?: (event: HostSupervisorEvent) => void
}>

type Deferred<Value> = {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(reason: unknown): void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export class HostSupervisor {
  readonly #options: Required<
    Pick<HostSupervisorOptions, 'stabilityMs' | 'startupTimeoutMs' | 'terminateGraceMs'>
  > &
    HostSupervisorOptions
  #process: ManagedHostProcess | undefined
  #protocol: LauncherProtocolSession | undefined
  #ready = deferred<HostReady>()
  #stop: Deferred<void> | undefined
  #surface: LoopbackSurface | undefined
  #origin: string | undefined
  #startupTimer: ReturnType<typeof setTimeout> | undefined
  #stabilityTimer: ReturnType<typeof setTimeout> | undefined
  #terminateTimer: ReturnType<typeof setTimeout> | undefined
  #killTimer: ReturnType<typeof setTimeout> | undefined
  #spawnPromise: Promise<void> | undefined
  #request: HostStartRequest | undefined
  #ownerRecorded = false
  #started = false
  #healthy = false
  #exited = false
  state: HostSupervisorState = 'idle'

  constructor(options: HostSupervisorOptions) {
    this.#options = {
      // The stability window holds Host readiness after the ready message to
      // attribute an immediately-crashing Host to boot failure. 100ms is the
      // value every packaged smoke has exercised (including host-crash); the
      // the crash-recovery chain owns later failures.
      stabilityMs: options.stabilityMs ?? 100,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      terminateGraceMs: options.terminateGraceMs ?? 2_000,
      ...options,
    }
  }

  start(request: HostStartRequest): Promise<HostReady> {
    if (this.#started) return Promise.reject(new Error('HostSupervisor can start only once'))
    this.#started = true
    this.state = 'starting'
    this.#request = request
    this.#spawnPromise = this.#spawn(request)
    return this.#ready.promise
  }

  stop(
    reason: Extract<LauncherToHostMessage, { kind: 'dispose' }>['reason'],
    deadlineMs: number,
  ): Promise<void> {
    if (this.#stop !== undefined) return this.#stop.promise
    this.#stop = deferred<void>()
    void (async () => {
      // A stop racing an in-flight spawn must still wait for and reap the
      // late child instead of leaking it.
      if (this.#spawnPromise !== undefined) {
        await this.#spawnPromise.catch(() => undefined)
      }
      if (this.#process === undefined || this.#exited) {
        this.state = 'stopped'
        await this.#clearOwnerRecord()
        this.#stop?.resolve()
        this.#emit({ kind: 'stopped' })
        return
      }
      this.state = 'draining'
      try {
        this.#process.postMessage(this.#protocol?.dispose(reason, deadlineMs))
      } catch {
        this.#process.terminate()
      }
      this.#terminateTimer = setTimeout(() => {
        if (this.#exited) return
        this.#process?.terminate()
        this.#killTimer = setTimeout(() => {
          if (!this.#exited && this.#process !== undefined) this.#killProcessNow(this.#process)
        }, this.#options.terminateGraceMs)
      }, deadlineMs)
    })()
    return this.#stop.promise
  }

  async #spawn(request: HostStartRequest): Promise<void> {
    try {
      // The session authorizes writes to ITS home; a mismatched request.home
      // would hand the Host write authorization for a different home —
      // refuse before anything is registered or spawned. The message carries
      // short digests, not the paths themselves: local paths never belong in
      // errors that reach logs or smoke reports.
      if (request.home !== request.session.home) {
        throw new HostControlError(
          'BOOT_FAILED',
          `session covers home ${homeDigest(request.session.home)}, not ${homeDigest(request.home)}`,
        )
      }
      const process = await this.#options.factory.spawnWaiting()
      this.#process = process
      try {
        await recordHostOwner({
          home: request.home,
          identity: { pid: process.pid, startIdentity: process.startIdentity },
          argvPin: request.argvPin,
        })
        this.#ownerRecorded = true
        const bootstrap: HostBootstrap = Object.freeze({
          home: request.home,
          profileName: request.profileName,
          mode: request.mode,
          capability: this.#capability,
          leaseGeneration: request.session.generation,
        })
        process.deliverBootstrap(bootstrap)
      } catch (error) {
        // The child never received boot credentials; reap it and, only when
        // its death is provable, clear the owner record.
        await this.#reapUnauthorizedChild(process)
        throw error
      }
      this.#protocol = new LauncherProtocolSession({
        capability: this.#capability,
        leaseGeneration: request.session.generation,
        expectedHost: { pid: process.pid, startIdentity: process.startIdentity },
        profileName: request.profileName,
        mode: request.mode,
      })
      process.onMessage((message) => this.#onMessage(message))
      process.onExit(() => this.#onExit())
      this.#emit({ kind: 'starting', pid: process.pid })
      this.#startupTimer = setTimeout(() => {
        this.#failStart(new HostControlError('BOOT_FAILED', 'Host startup timed out'))
      }, this.#options.startupTimeoutMs)
    } catch (error) {
      this.#failStart(
        error instanceof HostControlError
          ? error
          : error instanceof Error
            ? new HostControlError('BOOT_FAILED', `Host launch failed: ${error.message}`)
            : new HostControlError('BOOT_FAILED', 'Host process could not be created'),
      )
    }
  }

  #capability = randomBytes(32).toString('base64url')

  async #reapUnauthorizedChild(process: ManagedHostProcess): Promise<void> {
    let exited = false
    const exitedPromise = new Promise<void>((resolve) => {
      process.onExit(() => {
        exited = true
        // The supervisor-level exit listener is attached only after a
        // successful boot handoff; on this failure path this listener is the
        // ONLY observer, so the death must be recorded here — stop() and the
        // failure timers consult #exited and would otherwise wait forever on
        // a child that can never report again.
        this.#exited = true
        resolve()
      })
    })
    try {
      process.terminate()
    } catch {
      /* already gone */
    }
    await Promise.race([
      exitedPromise,
      new Promise<void>((resolve) => setTimeout(resolve, this.#options.terminateGraceMs)),
    ])
    if (!exited) {
      this.#killProcessNow(process)
      await Promise.race([exitedPromise, new Promise<void>((r) => setTimeout(r, 500))])
    }
    if (!exited) {
      // Leave the owner record in place: the next startup check will find the
      // pid still alive and settle it before starting a new Host.
      return
    }
    await this.#clearOwnerRecord()
  }

  async #clearOwnerRecord(): Promise<void> {
    if (this.#request === undefined || !this.#ownerRecorded) return
    await clearHostOwner(this.#request.home)
  }

  #onMessage(input: unknown): void {
    try {
      const message = this.#protocol?.receive(input)
      if (message === undefined)
        throw new HostControlError('INVALID_TRANSITION', 'Host protocol is unavailable')
      this.#handleMessage(message)
    } catch (error) {
      const failure =
        error instanceof HostControlError
          ? error
          : new HostControlError('INVALID_ENVELOPE', 'Host message was rejected')
      if (this.#healthy) this.#failHealthy(failure)
      else this.#failStart(failure)
    }
  }

  #handleMessage(message: HostToLauncherMessage): void {
    switch (message.kind) {
      case 'hello':
        this.#process?.postMessage(this.#protocol?.accept())
        return
      case 'surface':
        this.#surface = message.surface
        this.#origin = validateLoopbackSurface(message.surface)
        return
      case 'ready':
        if (
          this.#surface === undefined ||
          this.#origin === undefined ||
          this.#process === undefined
        ) {
          throw new HostControlError('INVALID_TRANSITION', 'Host became ready without a surface')
        }
        clearTimeout(this.#startupTimer)
        this.#stabilityTimer = setTimeout(() => {
          if (
            this.#exited ||
            this.#process === undefined ||
            this.#surface === undefined ||
            this.#origin === undefined
          ) {
            return
          }
          this.#healthy = true
          this.state = 'healthy'
          const ready = {
            pid: this.#process.pid,
            startIdentity: this.#process.startIdentity,
            surface: this.#surface,
            origin: this.#origin,
          }
          this.#ready.resolve(Object.freeze(ready))
          this.#emit({ kind: 'healthy', pid: this.#process.pid })
        }, this.#options.stabilityMs)
        return
      case 'fatal': {
        const fatal: HostFatalDetail = {
          stage: message.stage,
          code: message.code,
          summary: message.summary,
          retryable: message.retryable,
        }
        throw new FatalHostControlError('BOOT_FAILED', message.summary, fatal)
      }
      case 'dispose-ack':
      case 'phase':
        return
    }
  }

  #onExit(): void {
    if (this.#exited) return
    this.#exited = true
    this.#clearTimers()
    if (this.#stop !== undefined) {
      void this.#clearOwnerRecord().then(() => {
        this.state = 'stopped'
        if (!this.#healthy) {
          // A stop that raced the spawn still has to settle the start
          // promise: the child is gone and will never become ready.
          this.#ready.reject(
            new HostControlError('BOOT_FAILED', 'Host exited before becoming ready'),
          )
        }
        this.#stop?.resolve()
        this.#emit({ kind: 'stopped' })
      })
      return
    }
    if (this.state === 'failed') {
      void this.#clearOwnerRecord()
      return
    }
    if (!this.#healthy) {
      void this.#clearOwnerRecord().then(() => {
        this.#failStart(new HostControlError('BOOT_FAILED', 'Host exited before becoming ready'))
      })
      return
    }
    void this.#clearOwnerRecord().then(() => {
      const error = new HostControlError('HOST_CRASHED', 'Host exited after becoming ready')
      this.state = 'failed'
      this.#emit({ kind: 'crashed', error })
    })
  }

  #failStart(error: HostControlError): void {
    if (this.#healthy || this.state === 'failed') return
    this.#clearTimers()
    this.state = 'failed'
    this.#ready.reject(error)
    this.#emit({
      kind: 'failed',
      error,
      ...(error instanceof FatalHostControlError ? { fatal: error.fatal } : {}),
    })
    this.#terminateFailedProcess()
  }

  #failHealthy(error: HostControlError): void {
    if (!this.#healthy || this.state === 'failed') return
    this.#clearTimers()
    this.state = 'failed'
    this.#emit({ kind: 'crashed', error })
    this.#terminateFailedProcess()
  }

  #terminateFailedProcess(): void {
    if (this.#exited || this.#process === undefined) return
    try {
      this.#process.terminate()
    } catch {
      this.#killProcessNow(this.#process)
      return
    }
    this.#killTimer = setTimeout(() => {
      if (!this.#exited && this.#process !== undefined) this.#killProcessNow(this.#process)
    }, this.#options.terminateGraceMs)
  }

  /**
   * Kill the child, tolerating only ESRCH: the child died before this
   * supervisor observed the exit (it never attached the exit listener), so
   * the signal cannot be delivered — record the death instead of letting the
   * error escape into a timer callback.
   */
  #killProcessNow(process: ManagedHostProcess): void {
    try {
      process.kill()
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') throw error
      this.#exited = true
    }
  }

  #clearTimers(): void {
    clearTimeout(this.#startupTimer)
    clearTimeout(this.#stabilityTimer)
    clearTimeout(this.#terminateTimer)
    clearTimeout(this.#killTimer)
  }

  #emit(event: HostSupervisorEvent): void {
    this.#options.onEvent?.(event)
  }
}
