import { LeaseError, type HomeLease } from '@deskwork/home-lease'
import type { HostReady } from '@deskwork/host-supervisor'

import { shouldRollbackProfile, toStartupFailure, type StartupFailure } from './failure-policy.js'
import type { HostAttempt } from './lifecycle.js'

export type RecoveryAction = 'retry' | 'safe-mode' | 'quit'

export type RecoveryView = Readonly<{
  failure: StartupFailure
  retryAllowed: boolean
  safeModeAllowed: boolean
  doctorCommand: 'dsh-native doctor --unlock' | null
}>

export interface RecoveryController {
  getView(): RecoveryView
  act(action: RecoveryAction): Promise<void>
}

export interface RecoveryWindowPort {
  showRecoveryView(view: RecoveryView): Promise<void>
  destroySurface(): void
}

export type AttemptMode = 'normal' | 'safe'

export type CreateAttempt = (lease: HomeLease, mode: AttemptMode) => HostAttempt

/**
 * Home compatibility admission (M4): run after the lease is acquired and
 * before any profile/cache/Host write. The check receives the lease so the
 * writer reservation can bind to it, and refuses with a specific reason when
 * the home's data epoch or persisted formats are not provably compatible.
 * A refusal lands in the local recovery view with retry and Safe Mode
 * withdrawn.
 */
export type HomeAdmissionCheck = (
  lease: HomeLease,
) => Promise<
  | 'allow'
  | 'unknown-schema'
  | 'unsupported-data'
  | 'unknown-format'
  | 'unreadable-format'
  | 'migration-required'
>

export type ProfilePrepareResult =
  | Readonly<{ kind: 'ready'; transactionId?: string; changed: boolean }>
  | Readonly<{ kind: 'blocked'; failure: StartupFailure }>

/**
 * The profile-manager operations the session drives. Injected as a port so
 * the session stays testable against a fake profile layer; the production
 * implementation is `createDesktopProfileRecovery`. `prepare` settles
 * interrupted journals from previous runs, quarantines the rebuildable
 * projection cache, and applies the journaled reconcile before any Host boot.
 */
export interface ProfileRecoveryPort {
  prepare(lease: HomeLease): Promise<ProfilePrepareResult>
  /** Settle a pending transaction as committed: Host ready, surface mounted. */
  settleCommitted(transactionId: string, lease: HomeLease): Promise<void>
  rollback(transactionId: string, lease: HomeLease): Promise<'restored' | 'conflict'>
  retain(
    transactionId: string,
    lease: HomeLease,
    failure: Readonly<{ category: string; code: string }>,
  ): Promise<void>
  /** Switch the lease owner profile and prepare the desktop-safe-mode profile. */
  enterSafeMode(lease: HomeLease): Promise<'prepared' | 'conflict'>
  /** Restore the normal owner profile before a normal retry or release. */
  exitSafeMode(lease: HomeLease): Promise<void>
}

export type RecoverySessionOptions = Readonly<{
  acquireLease(): Promise<HomeLease>
  profile: ProfileRecoveryPort
  createAttempt: CreateAttempt
  loadSurface(ready: HostReady): Promise<void>
  window: RecoveryWindowPort
  shutdownDeadlineMs?: number
  onSessionFailure?(failure: StartupFailure): void
  /** Runs once per session that reached healthy, after the state flips. */
  onHealthy?(): Promise<void> | void
  onLeaseReleaseError?(error: unknown): void
  /**
   * Marker store for the single automatic profile-recovery relaunch. A marker
   * bound to the pending transaction means its budget is already spent, even
   * in a brand-new process.
   */
  readRecoveryMarker?(): Promise<unknown>
  writeRecoveryMarker?(marker: Readonly<{ transactionId: string; attempt: number }>): Promise<void>
  /** Manual-retry budget: at most `maxRetries` within `retryWindowMs`. */
  maxRetries?: number
  retryWindowMs?: number
  now?(): number
  /** Home compatibility admission gate (release-compatibility marker). */
  admitHome?: HomeAdmissionCheck
}>

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_WINDOW_MS = 60_000

type SessionState = 'idle' | 'starting' | 'healthy' | 'recovery' | 'stopping' | 'stopped'

/**
 * One desktop session: the outer lease is held once, each (re)try creates a
 * fresh one-shot Host attempt, and the launcher-owned recovery view drives
 * explicit, bounded retries. A failed boot settles its profile transaction
 * first — attributed failures roll the profile back and earn exactly one
 * automatic normal relaunch; everything else is retained untouched. Post-ready
 * crashes never auto-restart; manual retries are budgeted per rolling window;
 * quit always wins races.
 */
export class RecoverySessionController implements RecoveryController {
  readonly #options: RecoverySessionOptions
  #state: SessionState = 'idle'
  #lease: HomeLease | undefined
  #attempt: HostAttempt | undefined
  #failure: StartupFailure | undefined
  #retryTimestamps: number[] = []
  #inFlight: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined
  #attemptStop: Promise<void> | undefined
  #quitRequest = false
  #pendingTransaction: string | undefined
  #changed = false
  #surfaceMounted = false
  #mode: AttemptMode = 'normal'
  #autoRestartUsed = false
  #safeModeBlocked = false
  #leaseReleased = false
  #inFlightIsStart = false

  constructor(options: RecoverySessionOptions) {
    this.#options = options
  }

  get state(): SessionState {
    return this.#state
  }

  getView(): RecoveryView {
    if (this.#failure === undefined) {
      throw new Error('recovery view requested without a failure')
    }
    // Startup actions exist only while the session still holds the lease:
    // a lease-less recovery view may offer diagnosis and quit, nothing else.
    const leaseHeld = this.#lease !== undefined && !this.#leaseReleased
    // The doctor command applies to a leftover home lock after a full exit —
    // which never happens while this session holds the lease, so the view
    // never advertises it (advertising an unlock that doctor must refuse is
    // worse than silence).
    return Object.freeze({
      failure: this.#failure,
      retryAllowed:
        leaseHeld &&
        this.#state === 'recovery' &&
        this.#failure.retryable &&
        this.#retryBudgetRemaining() > 0,
      safeModeAllowed: leaseHeld && this.#state === 'recovery' && !this.#safeModeBlocked,
      doctorCommand: null,
    })
  }

  async start(): Promise<void> {
    if (this.#state !== 'idle') throw new Error('session can start only once')
    this.#state = 'starting'
    // Startup joins the in-flight chain so a quit arriving mid-acquisition
    // merges with it instead of exiting before the lease exists to release.
    const run = this.#startSession()
    this.#inFlight = run
    this.#inFlightIsStart = true
    try {
      await run
    } finally {
      if (this.#inFlight === run) {
        this.#inFlight = undefined
        this.#inFlightIsStart = false
      }
    }
  }

  async #startSession(): Promise<void> {
    try {
      const lease = await this.#options.acquireLease()
      this.#lease = lease
      await this.#admitHomeBeforeAnyWrite(lease)
      await this.#prepareAndRun(lease)
    } catch (error) {
      if (error instanceof LeaseError) {
        // Lease refusal belongs to the entry lifecycle (launcher dialog or
        // CLI exit code), not to the in-app recovery window.
        this.#state = 'recovery'
        throw error
      }
      await this.#failAndRecover(error)
      if (!this.#isHealthy()) throw error
    }
  }

  #isHealthy(): boolean {
    return this.#state === 'healthy'
  }

  /**
   * Admission refusal is a non-retryable, Safe-Mode-blocked home failure: no
   * supported write path may touch a home it cannot prove compatible. The
   * lease stays held for the diagnostic view and is released on quit.
   */
  async #admitHomeBeforeAnyWrite(lease: HomeLease): Promise<void> {
    const check = this.#options.admitHome
    if (check === undefined) return
    this.#safeModeBlocked = true
    let verdict: Awaited<ReturnType<HomeAdmissionCheck>>
    try {
      verdict = await check(lease)
    } catch (error) {
      throw new StartupFailureError({
        stage: 'home-admission',
        code: 'HOME_MARKER_UNREADABLE',
        category: 'home-config',
        summary: `无法读取数据目录的兼容性标记（${
          error instanceof Error ? error.message : String(error)
        }）；为避免破坏数据已停止启动。`,
        retryable: false,
      })
    }
    if (verdict === 'allow') {
      // A fresh verdict reopens Safe Mode for this session's recovery view.
      this.#safeModeBlocked = false
      return
    }
    const refusal: Record<
      Exclude<Awaited<ReturnType<HomeAdmissionCheck>>, 'allow'>,
      { code: string; summary: string }
    > = {
      'unknown-schema': {
        code: 'HOME_MARKER_UNKNOWN',
        summary:
          '这份数据目录的兼容性标记无法识别（缺失字段或来自未知版本）；为避免破坏数据已停止启动。',
      },
      'unsupported-data': {
        code: 'HOME_DATA_UNSUPPORTED',
        summary: '这份数据目录由更高数据版本写入，当前版本不支持；请使用写入它的版本打开。',
      },
      'unknown-format': {
        code: 'HOME_FORMAT_UNKNOWN',
        summary: '数据目录中存在当前版本无法识别的数据形态；为避免破坏数据已停止启动。',
      },
      'unreadable-format': {
        code: 'HOME_FORMAT_UNREADABLE',
        summary: '数据目录中存在当前版本无法读取的格式版本；请使用写入它的版本打开。',
      },
      'migration-required': {
        code: 'HOME_MIGRATION_REQUIRED',
        summary: '这份数据目录需要本版本不会自动执行的数据迁移；请保留数据并使用兼容版本。',
      },
    }
    throw new StartupFailureError({
      stage: 'home-admission',
      category: 'home-config',
      retryable: false,
      ...refusal[verdict],
    })
  }

  /**
   * A post-ready Host crash moves the session into recovery without touching
   * the outer lease: the attempt is already gone, and manual retry may build a
   * fresh attempt on the same lease. The crashed boot's profile transaction
   * was already committed — a post-ready crash never justifies reopening it.
   * The surface-mounted window also counts: a crash between mount and the
   * healthy transition must not leave a dead Host behind a healthy state.
   */
  async hostCrashed(failure?: StartupFailure): Promise<void> {
    if (this.#state !== 'healthy' && !this.#surfaceMounted) return
    if (this.#state === 'stopped' || this.#state === 'stopping') return
    this.#surfaceMounted = false
    this.#state = 'recovery'
    this.#failure = failure ?? {
      stage: 'host',
      code: 'HOST_CRASHED',
      category: 'runtime',
      summary: 'Host exited after becoming ready',
      retryable: true,
    }
    this.#options.onSessionFailure?.(this.#failure)
    this.#options.window.destroySurface()
    await this.#options.window.showRecoveryView(this.getView())
  }

  /**
   * The renderer surface died while the Host itself is still running (crash
   * budget exhausted). Unlike a Host crash the attempt is still alive, so it
   * is stopped here — its transaction already committed at healthy — and the
   * launcher-owned recovery view takes over. Manual retry boots a fresh Host.
   */
  async rendererCrashed(failure: StartupFailure): Promise<void> {
    if (this.#state !== 'healthy' && !this.#surfaceMounted) return
    if (this.#state === 'stopped' || this.#state === 'stopping') return
    this.#surfaceMounted = false
    this.#state = 'recovery'
    this.#failure = failure
    this.#options.onSessionFailure?.(failure)
    await this.#stopAttemptSafely()
    this.#options.window.destroySurface()
    await this.#options.window.showRecoveryView(this.getView())
  }

  async act(action: RecoveryAction): Promise<void> {
    if (action === 'quit') this.#quitRequest = true
    const inFlight = this.#inFlight
    if (inFlight !== undefined) {
      // Concurrent clicks merge into the in-flight action; quit upgrades it.
      const wasStart = this.#inFlightIsStart
      await inFlight.catch(() => undefined)
      if (this.#quitRequest && this.#state !== 'stopped') {
        await this.#stopAndRelease().catch(() => undefined)
        return
      }
      // A click that merged into the settling startup tail now runs as its
      // own action instead of being swallowed by the microtask window.
      if (!wasStart || action === 'quit') return
    }
    if (this.#quitRequest) {
      await this.#stopAndRelease()
      return
    }
    if (action === 'retry' && this.#state === 'recovery') {
      // The view hides the button; the controller still refuses non-retryable
      // failures so no renderer can force boot cycles the policy denied.
      if (this.#failure?.retryable === false) return
      if (this.#retryBudgetRemaining() <= 0) return
      const retry = this.#runAct(this.#retry())
      await retry
      if (this.#quitRequest) {
        await this.#stopAndRelease().catch(() => undefined)
      }
      return
    }
    if (action === 'safe-mode' && this.#state === 'recovery' && !this.#safeModeBlocked) {
      const enter = this.#runAct(this.#enterSafeMode())
      await enter
      if (this.#quitRequest) {
        await this.#stopAndRelease().catch(() => undefined)
      }
      return
    }
  }

  /** Track an action as in-flight with guaranteed cleanup on rejection. */
  #runAct(action: Promise<void>): Promise<void> {
    this.#inFlight = action
    return action.finally(() => {
      if (this.#inFlight === action) this.#inFlight = undefined
    })
  }

  async #retry(): Promise<void> {
    if (this.#lease === undefined || this.#quitRequest) return
    this.#recordRetry()
    this.#state = 'starting'
    try {
      if (this.#mode === 'safe') {
        await this.#options.profile.exitSafeMode(this.#lease)
        this.#mode = 'normal'
      }
      await this.#prepareAndRun(this.#lease)
    } catch (error) {
      await this.#failAndRecover(error)
    }
  }

  async #enterSafeMode(): Promise<void> {
    if (this.#lease === undefined || this.#quitRequest) return
    let entered: 'prepared' | 'conflict'
    try {
      entered = await this.#options.profile.enterSafeMode(this.#lease)
    } catch (error) {
      console.error('safe-mode entry failed:', error instanceof Error ? error.message : error)
      entered = 'conflict'
    }
    if (entered === 'conflict') {
      // Unknown user content in the safe profile: never overwrite it, stay on
      // the local recovery page with the Safe Mode entry withdrawn.
      this.#safeModeBlocked = true
      await this.#options.window.showRecoveryView(this.getView())
      return
    }
    this.#mode = 'safe'
    this.#state = 'starting'
    try {
      await this.#runAttempt(this.#lease, 'safe')
    } catch (error) {
      await this.#failAndRecover(error)
    }
  }

  async #prepareAndRun(lease: HomeLease): Promise<void> {
    if (this.#quitRequest) return
    const prepared = await this.#options.profile.prepare(lease)
    if (this.#quitRequest) return
    if (prepared.kind === 'blocked') throw new StartupFailureError(prepared.failure)
    this.#pendingTransaction = prepared.transactionId
    this.#changed = prepared.changed
    await this.#runAttempt(lease, 'normal')
  }

  async #runAttempt(lease: HomeLease, mode: AttemptMode): Promise<void> {
    if (this.#quitRequest) return
    const attempt = this.#options.createAttempt(lease, mode)
    this.#attempt = attempt
    this.#state = 'starting'
    this.#surfaceMounted = false
    const ready = await attempt.start()
    await this.#options.loadSurface(ready)
    this.#surfaceMounted = true
    // `committed` is written only after the Host became ready and the real
    // window mounted the surface — the transaction's evidence of health.
    if (this.#pendingTransaction !== undefined) {
      await this.#options.profile.settleCommitted(this.#pendingTransaction, lease)
      this.#pendingTransaction = undefined
    }
    // A crash handled by hostCrashed() during the commit awaits already moved
    // the session to recovery; never overwrite that verdict with healthy.
    if (this.#isInRecovery()) return
    this.#state = 'healthy'
    // Post-healthy work (relaunch marker clear, retiring the recovery
    // window) runs while the session is already healthy, so a crash in it
    // is still a post-ready crash.
    await Promise.resolve(this.#options.onHealthy?.()).catch((error: unknown) => {
      console.error('healthy-session hook failed:', error instanceof Error ? error.message : error)
    })
  }

  #isInRecovery(): boolean {
    return this.#state === 'recovery'
  }

  /**
   * Stop the failed attempt, settle its pending profile transaction, and show
   * the recovery view. An attributed failure with a matching journal rolls
   * the profile back and earns exactly one automatic normal relaunch; a
   * rollback conflict or a spent budget stops at the view.
   */
  async #failAndRecover(error: unknown): Promise<void> {
    for (;;) {
      const failure =
        error instanceof StartupFailureError
          ? error.failure
          : fallbackFailure(error, this.#lease?.home)
      await this.#stopAttemptSafely()
      this.#surfaceMounted = false
      this.#state = 'recovery'
      this.#failure = failure
      this.#options.onSessionFailure?.(failure)

      if (this.#pendingTransaction !== undefined && this.#lease !== undefined) {
        const transactionId = this.#pendingTransaction
        // #surfaceMounted was reset above: a failure past the mount never
        // rolls the transaction back (its health evidence stands).
        if (shouldRollbackProfile({ failure, changed: this.#changed, healthy: false })) {
          let outcome: 'restored' | 'conflict'
          try {
            outcome = await this.#options.profile.rollback(transactionId, this.#lease)
          } catch (rollbackError) {
            console.error(
              'profile rollback failed:',
              rollbackError instanceof Error ? rollbackError.message : rollbackError,
            )
            outcome = 'conflict'
          }
          if (outcome === 'restored') {
            this.#pendingTransaction = undefined
            if (!this.#quitRequest && (await this.#mayAutoRestart())) {
              // The marker write is part of spending the budget: if it cannot
              // be persisted, the relaunch must not happen — a process
              // restart would otherwise reset the home-scoped budget.
              let markerPersisted = true
              try {
                await this.#options.writeRecoveryMarker?.({ transactionId, attempt: 1 })
              } catch (markerError) {
                markerPersisted = false
                console.error(
                  'recovery marker could not be persisted; skipping the automatic relaunch:',
                  markerError instanceof Error ? markerError.message : markerError,
                )
              }
              if (markerPersisted) {
                this.#autoRestartUsed = true
                try {
                  await this.#prepareAndRun(this.#lease)
                  return // healthy again: no recovery view needed
                } catch (restartError) {
                  error = restartError
                  continue // settle the restarted run; the budget is spent
                }
              }
            }
            break
          }
          // Conflict: the journal records the divergence and stays untouched;
          // nothing about this transaction may be settled or rewritten later.
          this.#pendingTransaction = undefined
          break
        }
        await this.#options.profile
          .retain(transactionId, this.#lease, {
            category: failure.category,
            code: failure.code,
          })
          .catch((retainError: unknown) => {
            console.error(
              'profile transaction retain failed:',
              retainError instanceof Error ? retainError.message : retainError,
            )
          })
        this.#pendingTransaction = undefined
        break
      }
      break
    }
    this.#options.window.destroySurface()
    await this.#options.window.showRecoveryView(this.getView())
  }

  async #mayAutoRestart(): Promise<boolean> {
    if (this.#autoRestartUsed) return false
    // The relaunch budget is home-scoped, not transaction-scoped: a marker
    // left by any earlier recovery (this process or a previous one) means
    // the one automatic relaunch was already spent and never crowned by a
    // healthy session. Fresh transaction ids must not reset it. A marker
    // store that cannot be read at all is treated the same way — the
    // conservative reading never grants a second relaunch on I/O doubt.
    let marker: unknown
    try {
      marker = await this.#options.readRecoveryMarker?.()
    } catch (markerError) {
      console.error(
        'recovery marker could not be read; skipping the automatic relaunch:',
        markerError instanceof Error ? markerError.message : markerError,
      )
      return false
    }
    if (marker !== undefined && marker !== null && typeof marker === 'object') return false
    return true
  }

  async #stopAttemptSafely(): Promise<void> {
    const attempt = this.#attempt
    this.#attempt = undefined
    if (attempt !== undefined) {
      // Track the stop even when nobody awaits this call: a concurrent quit
      // must wait for it before releasing the home lease.
      this.#attemptStop = attempt
        .stop('quit', this.#options.shutdownDeadlineMs ?? 5_000)
        .catch(() => undefined)
    }
    await this.#attemptStop
  }

  #stopAndRelease(): Promise<void> {
    this.#stopPromise ??= this.#doStopAndRelease()
    return this.#stopPromise
  }

  async #doStopAndRelease(): Promise<void> {
    this.#state = 'stopping'
    try {
      await this.#stopAttemptSafely()
    } finally {
      if (this.#lease !== undefined) {
        try {
          await this.#lease.release()
          this.#leaseReleased = true
        } catch (error) {
          this.#options.onLeaseReleaseError?.(error)
        }
      }
      this.#state = 'stopped'
    }
  }

  #retryBudgetRemaining(): number {
    const now = this.#options.now?.() ?? Date.now()
    const windowMs = this.#options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS
    const max = this.#options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.#retryTimestamps = this.#retryTimestamps.filter((stamp) => now - stamp < windowMs)
    return max - this.#retryTimestamps.length
  }

  #recordRetry(): void {
    this.#retryTimestamps.push(this.#options.now?.() ?? Date.now())
  }
}

/** Wraps a classified startup failure for transport through the session. */
export class StartupFailureError extends Error {
  constructor(readonly failure: StartupFailure) {
    super(failure.summary)
    this.name = 'StartupFailureError'
  }
}

function fallbackFailure(error: unknown, home: string | undefined): StartupFailure {
  // Every failure that reaches the recovery view — including plain
  // exceptions from loadSurface, commit, or the profile port — goes through
  // the same redaction/classification pipeline as Host failures.
  return toStartupFailure({
    stage: 'unknown',
    code: 'UNKNOWN',
    summary: error instanceof Error ? error.message : String(error),
    retryable: true,
    home,
  })
}
