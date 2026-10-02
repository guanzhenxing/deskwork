import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEnvelopeWriter, type HostEnvelope } from '@deskwork/desktop-contracts/host-control'
import { createHomeSession, type HomeSession } from '@deskwork/desktop-contracts/home-session'

import { readHostOwner } from '../src/host-owner.js'
import { HostSupervisor, type HostBootstrap, type ManagedHostProcess } from '../src/supervisor.js'

class FakeProcess implements ManagedHostProcess {
  readonly pid = 4321
  readonly startIdentity = 'start-123'
  readonly posted: unknown[] = []
  terminateCount = 0
  killCount = 0
  /** Simulates a process that ignores signals; disabled by default. */
  unkillable = false
  /** Simulates a process that dies on signals; disabled by default. */
  killable = false
  /** Simulates the real process.kill ESRCH throw on an already-dead pid. */
  esrchOnKill = false
  /** Simulates a child that dies before boot credentials reach it. */
  failBootstrap = false
  bootstrap: HostBootstrap | undefined
  #messageListeners = new Set<(message: unknown) => void>()
  #exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>()

  deliverBootstrap(bootstrap: HostBootstrap): void {
    if (this.failBootstrap) throw new Error('child exited before boot credentials were delivered')
    this.bootstrap = bootstrap
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener)
    return () => this.#messageListeners.delete(listener)
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }

  terminate(): void {
    this.terminateCount += 1
    if (this.killable) queueMicrotask(() => this.emitExit(0))
  }

  kill(): void {
    this.killCount += 1
    if (this.esrchOnKill) {
      throw Object.assign(new Error(`kill(${this.pid}, SIGKILL): no such process`), {
        code: 'ESRCH',
      })
    }
    if (this.killable) queueMicrotask(() => this.emitExit(null, 'SIGKILL'))
  }

  emitMessage(message: HostEnvelope): void {
    for (const listener of this.#messageListeners) listener(message)
  }

  emitExit(code: number | null = 0, signal: string | null = null): void {
    for (const listener of this.#exitListeners) listener({ code, signal })
  }
}

const testHomes: string[] = []

afterEach(async () => {
  // maxRetries absorbs a record write that is still committing as the test ends.
  for (const home of testHomes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** One isolated home per test: the supervisor writes its owner record inside it. */
async function createTestHome(): Promise<{ home: string; session: HomeSession }> {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-supervisor-test-'))
  testHomes.push(home)
  return {
    home,
    session: createHomeSession({ home, profile: 'deskwork', generation: 'session-generation-1' }),
  }
}

/** The OS identity of this fake child, which is what the owner record carries. */

async function fixture(options: { stabilityMs?: number | null; startupTimeoutMs?: number } = {}) {
  const { home, session } = await createTestHome()
  const process = new FakeProcess()
  const events: string[] = []
  const fatalEvents: {
    stage: string
    code: string
    summary: string
    retryable: boolean
  }[] = []
  const supervisor = new HostSupervisor({
    factory: {
      async spawnWaiting() {
        events.push('spawn-waiting')
        return process
      },
    },
    ...(options.stabilityMs === null ? {} : { stabilityMs: options.stabilityMs ?? 0 }),
    startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
    terminateGraceMs: 100,
    onEvent: (event) => {
      events.push(event.kind)
      if (event.kind === 'failed' && event.fatal !== undefined) fatalEvents.push(event.fatal)
    },
  })
  return { events, fatalEvents, home, session, process, supervisor }
}

type StartTarget = Readonly<{ home: string; session: HomeSession }>

function startRequest(target: StartTarget) {
  return {
    home: target.home,
    profileName: 'deskwork',
    mode: 'normal' as const,
    session: target.session,
    argvPin: 'host-entry',
  }
}

async function startAndHello(setup: Awaited<ReturnType<typeof fixture>>) {
  const started = setup.supervisor.start(startRequest(setup))
  void started.catch(() => undefined)
  await vi.waitFor(() => expect(setup.process.bootstrap).toBeDefined())
  const bootstrap = setup.process.bootstrap!
  const hostWriter = createEnvelopeWriter(
    'host-to-launcher',
    bootstrap.capability,
    bootstrap.leaseGeneration,
  )
  setup.process.emitMessage(
    hostWriter.next({
      kind: 'hello',
      host: { pid: setup.process.pid, startIdentity: setup.process.startIdentity },
      profile: { name: bootstrap.profileName },
      mode: bootstrap.mode,
      supportedMinor: { min: 0, max: 0 },
    }),
  )
  expect(setup.process.posted).toHaveLength(1)
  expect(setup.process.posted[0]).toMatchObject({ message: { kind: 'accept' } })
  return { bootstrap, hostWriter, started }
}

describe('HostSupervisor session ordering', () => {
  it('records the spawned Host as the home owner before authorizing boot', async () => {
    const setup = await fixture()
    const { bootstrap, hostWriter, started } = await startAndHello(setup)
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'surface-waiting' }))
    setup.process.emitMessage(
      hostWriter.next({
        kind: 'surface',
        surfaceId: 'surface-1',
        purpose: 'normal',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/' },
      }),
    )
    setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
    await started
    expect(bootstrap.leaseGeneration).toBe('session-generation-1')
    // The record carries reachability only; the kernel lock, taken by the
    // Host itself, is what proves a Host is alive.
    expect(await readHostOwner(setup.home)).toMatchObject({
      pid: setup.process.pid,
      argvPin: 'host-entry',
    })
  })

  it('refuses a start whose home does not match the session home', async () => {
    const setup = await fixture()
    const request = { ...startRequest(setup), home: '/tmp/a-different-home' }
    const rejection = await setup.supervisor.start(request).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(rejection).toMatchObject({
      code: 'BOOT_FAILED',
      message: /session covers home #/u,
    })
    // Local paths never reach logs or smoke reports, even from this guard.
    expect((rejection as Error).message).not.toContain('/tmp/a-different-home')
    // Nothing spawned: the session's home claim is enforced before any state
    // changes.
    expect(setup.events).not.toContain('spawn-waiting')
  })

  it('keeps the owner record when an unauthorized child is unkillable', async () => {
    const setup = await fixture()
    setup.process.unkillable = true
    // The child never received boot credentials, so it is reaped; the failure
    // lands after the record was written, leaving the death unproven.
    setup.process.failBootstrap = true
    await expect(setup.supervisor.start(startRequest(setup))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    expect(setup.process.bootstrap).toBeUndefined()
    expect(setup.process.terminateCount).toBeGreaterThanOrEqual(1)
    expect(setup.process.killCount).toBeGreaterThanOrEqual(1)
    // No clear: a record whose pid may still be writing stays for the next
    // startup check to settle.
    expect((await readHostOwner(setup.home))?.pid).toBe(setup.process.pid)
  })

  it('reaps an unauthorized child and clears the owner record once it is dead', async () => {
    const setup = await fixture()
    setup.process.killable = true
    setup.process.failBootstrap = true
    await expect(setup.supervisor.start(startRequest(setup))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    expect(setup.process.bootstrap).toBeUndefined()
    expect(setup.process.terminateCount).toBeGreaterThanOrEqual(1)
    await vi.waitFor(async () => expect(await readHostOwner(setup.home)).toBeUndefined())
  })

  it('resolves stop() after an authorization failure already reaped the child', async () => {
    // Regression: the child died between spawn and the supervisor's exit
    // listener being attached, so only the reap listener observed the death —
    // stop() must not drain forever on a child that can never report again.
    const setup = await fixture()
    setup.process.killable = true
    setup.process.failBootstrap = true
    await expect(setup.supervisor.start(startRequest(setup))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    const settled = await Promise.race([
      setup.supervisor.stop('quit', 1_000).then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ])
    expect(settled).toBe('settled')
    expect(setup.events).toContain('stopped')
  })

  it('treats an ESRCH kill of the already-dead child as observed exit', async () => {
    const setup = await fixture()
    setup.process.esrchOnKill = true
    setup.process.failBootstrap = true
    await expect(setup.supervisor.start(startRequest(setup))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    const settled = await Promise.race([
      setup.supervisor.stop('quit', 1_000).then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ])
    expect(settled).toBe('settled')
    expect(setup.events).toContain('stopped')
  })

  it('waits for a late child when stop races the spawn', async () => {
    const { home, session } = await createTestHome()
    const process = new FakeProcess()
    let releaseSpawn!: (value: FakeProcess) => void
    const spawnGate = new Promise<FakeProcess>((resolve) => {
      releaseSpawn = resolve
    })
    const supervisor = new HostSupervisor({
      factory: {
        async spawnWaiting() {
          return await spawnGate
        },
      },
      stabilityMs: 0,
      terminateGraceMs: 100,
    })
    const started = supervisor.start(startRequest({ home, session }))
    const stopping = supervisor.stop('quit', 1_000)
    releaseSpawn(process)
    // The late child never completed the handshake, so the pending stop can
    // only terminate it — but it is still reaped, never leaked.
    await vi.waitFor(() => expect(process.terminateCount).toBeGreaterThanOrEqual(1))
    process.emitExit(0)
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
    await stopping
    expect(await readHostOwner(home)).toBeUndefined()
  })
})

describe('HostSupervisor', () => {
  it('bounds startup when the Host never sends hello', async () => {
    vi.useFakeTimers()
    try {
      const setup = await fixture({ startupTimeoutMs: 250 })
      const started = setup.supervisor.start(startRequest(setup))
      const outcome = started.catch((error: unknown) => error)
      await vi.waitFor(() => expect(setup.process.bootstrap).toBeDefined())
      await vi.advanceTimersByTimeAsync(250)
      await expect(outcome).resolves.toMatchObject({ code: 'BOOT_FAILED' })
      expect(setup.process.terminateCount).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(setup.process.killCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the default stability window is the uniform packaged value (100ms)', async () => {
    vi.useFakeTimers()
    try {
      const setup = await fixture({ stabilityMs: null })
      const { hostWriter, started } = await startAndHello(setup)
      setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
      setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'surface-waiting' }))
      setup.process.emitMessage(
        hostWriter.next({
          kind: 'surface',
          surfaceId: 'surface-1',
          purpose: 'normal',
          surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=secret' },
        }),
      )
      setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
      let resolved = false
      void started.then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(99)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(started).resolves.toMatchObject({ pid: 4321 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves only after surface, ready and the stability window', async () => {
    vi.useFakeTimers()
    try {
      const setup = await fixture({ stabilityMs: 250 })
      const { hostWriter, started } = await startAndHello(setup)
      setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
      setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'surface-waiting' }))
      setup.process.emitMessage(
        hostWriter.next({
          kind: 'surface',
          surfaceId: 'surface-1',
          purpose: 'normal',
          surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=secret' },
        }),
      )
      setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
      let resolved = false
      void started.then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(started).resolves.toMatchObject({
        pid: 4321,
        surface: { kind: 'loopback' },
        origin: 'http://127.0.0.1:43123',
      })
      expect(setup.events).toContain('healthy')
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies an exit before ready as BOOT_FAILED and clears the owner record', async () => {
    const setup = await fixture()
    const { started } = await startAndHello(setup)
    setup.process.emitExit(1)
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
    await vi.waitFor(async () => expect(await readHostOwner(setup.home)).toBeUndefined())
  })

  it('preserves the fatal stage and code instead of flattening to BOOT_FAILED', async () => {
    const setup = await fixture()
    const { hostWriter, started } = await startAndHello(setup)
    setup.process.emitMessage(
      hostWriter.next({
        kind: 'fatal',
        stage: 'load-home-patch',
        code: 'HOME_PATCH_INVALID',
        summary: 'yaml is not a patch list',
        retryable: false,
      }),
    )
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
    expect(setup.fatalEvents[0]).toEqual({
      stage: 'load-home-patch',
      code: 'HOME_PATCH_INVALID',
      summary: 'yaml is not a patch list',
      retryable: false,
    })
  })

  it('keeps the supervisor alive and reports HOST_CRASHED after ready', async () => {
    const setup = await fixture()
    const { hostWriter, started } = await startAndHello(setup)
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'surface-waiting' }))
    setup.process.emitMessage(
      hostWriter.next({
        kind: 'surface',
        surfaceId: 'surface-1',
        purpose: 'normal',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/' },
      }),
    )
    setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
    await started
    setup.process.emitExit(1, 'SIGKILL')
    await vi.waitFor(() => {
      expect(setup.events).toContain('crashed')
      expect(setup.supervisor.state).toBe('failed')
    })
    await vi.waitFor(async () => expect(await readHostOwner(setup.home)).toBeUndefined())
  })

  it('terminates a healthy Host after a protocol violation', async () => {
    const setup = await fixture()
    const { hostWriter, started } = await startAndHello(setup)
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    setup.process.emitMessage(
      hostWriter.next({
        kind: 'surface',
        surfaceId: 'surface-1',
        purpose: 'normal',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/' },
      }),
    )
    setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
    await started

    setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
    expect(setup.supervisor.state).toBe('failed')
    expect(setup.process.terminateCount).toBe(1)
    expect(setup.events).toContain('crashed')
    setup.process.emitExit(1, 'SIGTERM')
    expect(setup.events.filter((event) => event === 'crashed')).toHaveLength(1)
    await vi.waitFor(async () => expect(await readHostOwner(setup.home)).toBeUndefined())
  })

  it('merges stop requests and accepts dispose ack plus process exit', async () => {
    const setup = await fixture()
    const { hostWriter } = await startAndHello(setup)
    const first = setup.supervisor.stop('quit', 1_000)
    const second = setup.supervisor.stop('quit', 1_000)
    await vi.waitFor(() =>
      expect(
        setup.process.posted.filter(
          (item) => (item as { message?: { kind?: string } }).message?.kind === 'dispose',
        ),
      ).toHaveLength(1),
    )
    setup.process.emitMessage(hostWriter.next({ kind: 'dispose-ack', outcome: 'disposed' }))
    setup.process.emitExit(0)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    await vi.waitFor(async () => expect(await readHostOwner(setup.home)).toBeUndefined())
  })

  it('escalates from graceful dispose to terminate and force kill', async () => {
    vi.useFakeTimers()
    try {
      const setup = await fixture()
      await startAndHello(setup)
      const stopped = setup.supervisor.stop('quit', 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(setup.process.terminateCount).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(setup.process.killCount).toBe(1)
      setup.process.emitExit(null, 'SIGKILL')
      await stopped
    } finally {
      vi.useRealTimers()
    }
  })
})
