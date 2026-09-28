import { describe, expect, it, vi } from 'vitest'

import type { HomeLease, ProcessIdentity, ProcessProbe } from '@deskwork/home-lease'
import { createEnvelopeWriter, type HostEnvelope } from '@deskwork/desktop-contracts/host-control'

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
  bootstrap: HostBootstrap | undefined
  #messageListeners = new Set<(message: unknown) => void>()
  #exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>()

  deliverBootstrap(bootstrap: HostBootstrap): void {
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

class RecordingLease implements HomeLease {
  readonly home = '/tmp/isolated-home'
  readonly generation = 'lease-generation-1'
  readonly calls: string[] = []
  refuseAt: 'beforeSpawn' | 'attachHost' | undefined
  /** When set, assertHeld rejects with this error (watchdog tests). */
  assertHeldError: Error | undefined
  /** Codes that simulate transient contention instead of lease loss. */
  assertHeldBusyTimes = 0

  async assertHeld(): Promise<void> {
    this.calls.push('assertHeld')
    if (this.assertHeldBusyTimes > 0) {
      this.assertHeldBusyTimes -= 1
      throw Object.assign(new Error('critical section contended'), { code: 'GUARD_BUSY' })
    }
    if (this.assertHeldError !== undefined) throw this.assertHeldError
  }

  async beforeSpawn(profile: string): Promise<void> {
    this.calls.push(`beforeSpawn:${profile}`)
    if (this.refuseAt === 'beforeSpawn') throw new Error('lease refused the spawn')
  }

  async attachHost(identity: ProcessIdentity): Promise<void> {
    this.calls.push(`attachHost:${identity.pid}`)
    if (this.refuseAt === 'attachHost') throw new Error('lease refused the host identity')
  }

  async confirmHostExited(): Promise<void> {
    this.calls.push('confirmHostExited')
  }
  async switchProfile(nextProfile: string): Promise<void> {
    this.calls.push(`switchProfile:${nextProfile}`)
  }

  async release(): Promise<void> {
    this.calls.push('release')
  }
}

const fakeProbe: ProcessProbe = {
  async current() {
    return { pid: process.pid, startIdentity: 'probe-self' }
  },
  async identify(pid) {
    return { pid, startIdentity: 'os-identity' }
  },
  async inspect() {
    return 'same' as const
  },
  async scanSupported() {
    return 'none' as const
  },
}

function fixture(options: { stabilityMs?: number | null; startupTimeoutMs?: number } = {}) {
  const process = new FakeProcess()
  const lease = new RecordingLease()
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
  return { events, fatalEvents, lease, process, supervisor }
}

function startRequest(lease: RecordingLease) {
  return {
    home: '/tmp/isolated-home',
    profileName: 'deskwork',
    mode: 'normal' as const,
    lease,
    probe: fakeProbe,
  }
}

async function startAndHello(setup: ReturnType<typeof fixture>) {
  const started = setup.supervisor.start(startRequest(setup.lease))
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

describe('HostSupervisor lease ordering', () => {
  it('persists the pending spawn, registers the OS identity, then authorizes boot', async () => {
    const setup = fixture()
    await startAndHello(setup)
    const order = [setup.lease.calls[0], setup.events[0], setup.lease.calls[1], 'bootstrap']
    expect(setup.lease.calls).toEqual(['beforeSpawn:deskwork', 'attachHost:4321'])
    expect(order).toEqual(['beforeSpawn:deskwork', 'spawn-waiting', 'attachHost:4321', 'bootstrap'])
    expect(setup.process.bootstrap?.leaseGeneration).toBe('lease-generation-1')
  })

  it('creates no process when the lease refuses the spawn', async () => {
    const setup = fixture()
    setup.lease.refuseAt = 'beforeSpawn'
    await expect(setup.supervisor.start(startRequest(setup.lease))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    expect(setup.events).not.toContain('spawn-waiting')
    expect(setup.process.bootstrap).toBeUndefined()
  })

  it('refuses a start whose home does not match the lease home', async () => {
    const setup = fixture()
    const request = { ...startRequest(setup.lease), home: '/tmp/a-different-home' }
    const rejection = await setup.supervisor.start(request).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(rejection).toMatchObject({
      code: 'BOOT_FAILED',
      message: /lease covers home #/u,
    })
    // Local paths never reach logs or smoke reports, even from this guard.
    expect((rejection as Error).message).not.toContain('/tmp/a-different-home')
    // Nothing registered, nothing spawned: the whole-home single-writer
    // guarantee is enforced before any state changes.
    expect(setup.events).not.toContain('spawn-waiting')
    expect(setup.lease.calls).toEqual([])
  })

  it('keeps the pending spawn flagged when an unauthorized child is unkillable', async () => {
    const setup = fixture()
    setup.process.unkillable = true
    setup.lease.refuseAt = 'attachHost'
    await expect(setup.supervisor.start(startRequest(setup.lease))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    expect(setup.process.bootstrap).toBeUndefined()
    expect(setup.process.terminateCount).toBeGreaterThanOrEqual(1)
    expect(setup.process.killCount).toBeGreaterThanOrEqual(1)
    // No confirm: the lease keeps pendingSpawn so a release will refuse.
    expect(setup.lease.calls).not.toContain('confirmHostExited')
  })

  it('reaps an unauthorized child and clears the pending spawn when attach fails', async () => {
    const setup = fixture()
    setup.process.killable = true
    setup.lease.refuseAt = 'attachHost'
    await expect(setup.supervisor.start(startRequest(setup.lease))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    expect(setup.process.bootstrap).toBeUndefined()
    expect(setup.process.terminateCount).toBeGreaterThanOrEqual(1)
    expect(setup.lease.calls).toContain('confirmHostExited')
  })

  it('resolves stop() after an attach failure already reaped the child', async () => {
    // Regression: the child died between spawn and the supervisor's exit
    // listener being attached, so only the reap listener observed the death —
    // stop() must not drain forever on a child that can never report again.
    const setup = fixture()
    setup.process.killable = true
    setup.lease.refuseAt = 'attachHost'
    await expect(setup.supervisor.start(startRequest(setup.lease))).rejects.toMatchObject({
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
    const setup = fixture()
    setup.process.esrchOnKill = true
    setup.lease.refuseAt = 'attachHost'
    await expect(setup.supervisor.start(startRequest(setup.lease))).rejects.toMatchObject({
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
    const process = new FakeProcess()
    const lease = new RecordingLease()
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
    const started = supervisor.start(startRequest(lease))
    const stopping = supervisor.stop('quit', 1_000)
    releaseSpawn(process)
    // The late child never completed the handshake, so the pending stop can
    // only terminate it — but it is still reaped, never leaked.
    await vi.waitFor(() => expect(process.terminateCount).toBeGreaterThanOrEqual(1))
    process.emitExit(0)
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
    await stopping
    expect(lease.calls).toContain('confirmHostExited')
    expect(lease.calls).not.toContain('release')
  })
})

describe('HostSupervisor', () => {
  it('bounds startup when the Host never sends hello', async () => {
    vi.useFakeTimers()
    try {
      const setup = fixture({ startupTimeoutMs: 250 })
      const started = setup.supervisor.start(startRequest(setup.lease))
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
      const setup = fixture({ stabilityMs: null })
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
      const setup = fixture({ stabilityMs: 250 })
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

  it('classifies an exit before ready as BOOT_FAILED and confirms the lease exit', async () => {
    const setup = fixture()
    const { started } = await startAndHello(setup)
    setup.process.emitExit(1)
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
    await vi.waitFor(() => expect(setup.lease.calls).toContain('confirmHostExited'))
  })

  it('preserves the fatal stage and code instead of flattening to BOOT_FAILED', async () => {
    const setup = fixture()
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
    const setup = fixture()
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
      expect(setup.lease.calls).toContain('confirmHostExited')
    })
  })

  it('terminates a healthy Host after a protocol violation', async () => {
    const setup = fixture()
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
  })

  it('merges stop requests and accepts dispose ack plus process exit', async () => {
    const setup = fixture()
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
    await vi.waitFor(() => expect(setup.lease.calls).toContain('confirmHostExited'))
  })

  it('escalates from graceful dispose to terminate and force kill', async () => {
    vi.useFakeTimers()
    try {
      const setup = fixture()
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

describe('HostSupervisor lease watchdog', () => {
  it('terminates a healthy Host when the lease is lost underneath it', async () => {
    vi.useFakeTimers()
    try {
      const process = new FakeProcess()
      const lease = new RecordingLease()
      const events: string[] = []
      const supervisor = new HostSupervisor({
        factory: {
          async spawnWaiting() {
            return process
          },
        },
        stabilityMs: 0,
        startupTimeoutMs: 10_000,
        terminateGraceMs: 50,
        watchdogIntervalMs: 100,
        onEvent: (event) => events.push(event.kind),
      })
      const started = supervisor.start({
        home: '/tmp/isolated-home',
        profileName: 'deskwork',
        mode: 'normal',
        lease,
        probe: fakeProbe,
      })
      await vi.waitFor(() => expect(process.bootstrap).toBeDefined())
      const writer = createEnvelopeWriter(
        'host-to-launcher',
        process.bootstrap!.capability,
        process.bootstrap!.leaseGeneration,
      )
      process.emitMessage(
        writer.next({
          kind: 'hello',
          host: { pid: process.pid, startIdentity: process.startIdentity },
          profile: { name: process.bootstrap!.profileName },
          mode: process.bootstrap!.mode,
          supportedMinor: { min: 0, max: 0 },
        }),
      )
      process.emitMessage(writer.next({ kind: 'phase', phase: 'booting' }))
      process.emitMessage(writer.next({ kind: 'phase', phase: 'surface-waiting' }))
      process.emitMessage(
        writer.next({
          kind: 'surface',
          surfaceId: 'surface-1',
          purpose: 'normal',
          surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=secret' },
        }),
      )
      process.emitMessage(writer.next({ kind: 'ready', surfaceId: 'surface-1' }))
      await vi.advanceTimersByTimeAsync(1)
      await started
      expect(events).toContain('healthy')
      lease.assertHeldError = Object.assign(new Error('home lease generation changed'), {
        code: 'LEASE_CHANGED',
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(events).not.toContain('crashed') // first failure is not yet fatal
      await vi.advanceTimersByTimeAsync(100)
      expect(events).toContain('crashed')
      expect(process.terminateCount).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a starting Host when the lease is lost before ready', async () => {
    vi.useFakeTimers()
    try {
      const process = new FakeProcess()
      const lease = new RecordingLease()
      const events: string[] = []
      const supervisor = new HostSupervisor({
        factory: {
          async spawnWaiting() {
            return process
          },
        },
        stabilityMs: 0,
        startupTimeoutMs: 10_000,
        terminateGraceMs: 50,
        watchdogIntervalMs: 100,
        onEvent: (event) => events.push(event.kind),
      })
      const started = supervisor.start({
        home: '/tmp/isolated-home',
        profileName: 'deskwork',
        mode: 'normal',
        lease,
        probe: fakeProbe,
      })
      const outcome = started.catch((error: unknown) => error)
      // The Host received its bootstrap (watchdog armed) but never reported
      // ready; the lease then disappears underneath the STARTING process.
      await vi.waitFor(() => expect(process.bootstrap).toBeDefined())
      lease.assertHeldError = Object.assign(new Error('lock vanished'), {
        code: 'LEASE_CHANGED',
      })
      await vi.advanceTimersByTimeAsync(300)
      const error = (await outcome) as { code?: string }
      expect(error.code).toBe('LEASE_MISMATCH')
      expect(process.terminateCount).toBeGreaterThan(0)
      expect(events).toContain('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores guard contention and transient single failures', async () => {
    vi.useFakeTimers()
    try {
      const process = new FakeProcess()
      const lease = new RecordingLease()
      const events: string[] = []
      const supervisor = new HostSupervisor({
        factory: {
          async spawnWaiting() {
            return process
          },
        },
        stabilityMs: 0,
        startupTimeoutMs: 10_000,
        terminateGraceMs: 50,
        watchdogIntervalMs: 100,
        onEvent: (event) => events.push(event.kind),
      })
      const started = supervisor.start({
        home: '/tmp/isolated-home',
        profileName: 'deskwork',
        mode: 'normal',
        lease,
        probe: fakeProbe,
      })
      await vi.waitFor(() => expect(process.bootstrap).toBeDefined())
      const writer = createEnvelopeWriter(
        'host-to-launcher',
        process.bootstrap!.capability,
        process.bootstrap!.leaseGeneration,
      )
      process.emitMessage(
        writer.next({
          kind: 'hello',
          host: { pid: process.pid, startIdentity: process.startIdentity },
          profile: { name: process.bootstrap!.profileName },
          mode: process.bootstrap!.mode,
          supportedMinor: { min: 0, max: 0 },
        }),
      )
      process.emitMessage(writer.next({ kind: 'phase', phase: 'booting' }))
      process.emitMessage(writer.next({ kind: 'phase', phase: 'surface-waiting' }))
      process.emitMessage(
        writer.next({
          kind: 'surface',
          surfaceId: 'surface-1',
          purpose: 'normal',
          surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=secret' },
        }),
      )
      process.emitMessage(writer.next({ kind: 'ready', surfaceId: 'surface-1' }))
      await vi.advanceTimersByTimeAsync(1)
      await started
      // Guard contention never counts.
      lease.assertHeldBusyTimes = 5
      await vi.advanceTimersByTimeAsync(500)
      expect(events).not.toContain('crashed')
      lease.assertHeldBusyTimes = 0
      // One real failure followed by recovery resets the streak.
      lease.assertHeldError = Object.assign(new Error('one bad probe'), {
        code: 'LEASE_CHANGED',
      })
      await vi.advanceTimersByTimeAsync(100)
      lease.assertHeldError = undefined
      await vi.advanceTimersByTimeAsync(300)
      expect(events).not.toContain('crashed')
      expect(process.terminateCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
