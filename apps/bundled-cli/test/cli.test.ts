import { readFileSync, realpathSync } from 'node:fs'
import { stat as statAsync, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createInProcessGuardLock,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'

import {
  planCliInvocation,
  runBundledCli,
  startLeaseWatchdog,
  type CliChildHandle,
  type SpawnCliChild,
} from '../src/main.js'
import { resolvePackagedCliRuntime } from '../src/runtime-paths.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const fixtures: IsolatedHomeFixture[] = []

async function isolatedHome(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

class MemoryStderr extends Writable {
  readonly chunks: string[] = []

  override _write(
    chunk: string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(String(chunk))
    callback()
  }

  text(): string {
    return this.chunks.join('')
  }
}

const fakeProbe: ProcessProbe = {
  async current() {
    return { pid: process.pid, startIdentity: 'wrapper-self' }
  },
  async identify(pid) {
    return { pid, startIdentity: 'cli-child-os' }
  },
  async inspect() {
    return 'same' as const
  },
  async scanSupported() {
    return 'none' as const
  },
}

function makeFakeChild(exitCode = 0): {
  spawn: SpawnCliChild
  forwarded: () => unknown[]
  kills: () => readonly NodeJS.Signals[]
} {
  const forwardedMessages: unknown[] = []
  const killSignals: NodeJS.Signals[] = []
  const spawn: SpawnCliChild = () => {
    const handle: CliChildHandle = {
      pid: 5555,
      send(message) {
        forwardedMessages.push(message)
      },
      exited: Promise.resolve({ code: exitCode, signal: null }),
      kill(signal = 'SIGTERM') {
        killSignals.push(signal)
      },
    }
    return handle
  }
  return { spawn, forwarded: () => forwardedMessages, kills: () => [...killSignals] }
}

function ownerPathOf(home: string): string {
  return path.join(home, 'run', 'host.lock', 'owner.json')
}

describe('planCliInvocation', () => {
  it('intercepts only the exact doctor unlock command', () => {
    expect(planCliInvocation(['doctor', '--unlock'])).toEqual({ kind: 'doctor-unlock' })
    expect(planCliInvocation(['doctor'])).toMatchObject({ kind: 'passthrough' })
    expect(planCliInvocation(['doctor', '--unlock', '--extra'])).toMatchObject({
      kind: 'passthrough',
    })
  })

  it('resolves profiles the way the upstream launcher does', () => {
    expect(planCliInvocation(['--profile', 'headless'])).toEqual({
      kind: 'passthrough',
      profile: 'headless',
    })
    expect(planCliInvocation(['web'])).toEqual({ kind: 'passthrough', profile: 'web' })
    expect(planCliInvocation(['plugin', '--profile', 'deskwork', 'add', '@example/a'])).toEqual({
      kind: 'passthrough',
      profile: 'deskwork',
    })
    expect(planCliInvocation(['--profile=web', 'inner'])).toEqual({
      kind: 'passthrough',
      profile: 'web',
    })
    expect(planCliInvocation([])).toEqual({ kind: 'passthrough', profile: undefined })
    expect(planCliInvocation(['just', 'a', 'task'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
    expect(planCliInvocation(['--patch', 'a.yml', 'task'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
    expect(planCliInvocation(['--profile', 'tui', '--resume', 'abc'])).toEqual({
      kind: 'passthrough',
      profile: 'tui',
    })
    expect(planCliInvocation(['--profile'])).toEqual({ kind: 'passthrough', profile: undefined })
  })

  it('still takes the lease when --patch precedes --profile', () => {
    // Regression: --patch's value was mistaken for the first positional, so
    // the scan stopped early and a write-mode invocation rode the lease-less
    // branch while upstream parsed --profile normally.
    expect(planCliInvocation(['--patch', 'overlay.yml', '--profile', 'headless', 'task'])).toEqual({
      kind: 'passthrough',
      profile: 'headless',
    })
    expect(planCliInvocation(['--patch=a.yml', '--profile=b', 'inner'])).toEqual({
      kind: 'passthrough',
      profile: 'b',
    })
    // Value-less trailing flags are upstream's error; never a lease we
    // cannot attribute.
    expect(planCliInvocation(['--profile', 'tui', '--patch'])).toEqual({
      kind: 'passthrough',
      profile: 'tui',
    })
    // Root launcher flags stop at the first positional or `--`; beyond that
    // they belong to the inner app and must not change lease attribution.
    expect(planCliInvocation(['run', '--profile', 'x'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
    expect(planCliInvocation(['--', '--profile', 'x'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
    // The `plugin` subcommand is different: bundle names are positionals
    // that legitimately precede `--profile`, and upstream Commander parses
    // the flag wherever it appears — so the scan must keep walking them.
    expect(planCliInvocation(['plugin', 'add', '--profile', 'x'])).toEqual({
      kind: 'passthrough',
      profile: 'x',
    })
    expect(planCliInvocation(['plugin', 'add', '@example/a', '--profile', 'deskwork'])).toEqual({
      kind: 'passthrough',
      profile: 'deskwork',
    })
    expect(planCliInvocation(['plugin', 'remove', 'a', 'b', '--profile=x'])).toEqual({
      kind: 'passthrough',
      profile: 'x',
    })
    // Operands after `--` are bundle names, not options, upstream and here.
    expect(planCliInvocation(['plugin', 'add', 'fixture', '--', '--profile', 'x'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
    // No `--profile` anywhere: upstream rejects the invocation itself.
    expect(planCliInvocation(['plugin', 'add', 'fixture'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
  })
})

describe('startLeaseWatchdog', () => {
  it('never kills on sustained guard contention', async () => {
    const killSignals: NodeJS.Signals[] = []
    const child: CliChildHandle = {
      pid: 1,
      send() {},
      exited: new Promise(() => {}),
      kill(signal = 'SIGTERM') {
        killSignals.push(signal)
      },
    }
    const lease = {
      home: '/tmp/h',
      generation: 'g',
      assertHeld: async () => {
        throw Object.assign(new Error('critical section contended'), { code: 'GUARD_BUSY' })
      },
    } as unknown as Parameters<typeof startLeaseWatchdog>[0]
    const stderrLines: string[] = []
    const watchdog = startLeaseWatchdog(
      lease,
      child,
      { write: (line: string) => stderrLines.push(line) } as never,
      10,
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(killSignals).toEqual([])
      expect(stderrLines).toEqual([])
    } finally {
      watchdog.stop()
    }
  })

  it('ignores failed checks that complete after the watchdog has stopped', async () => {
    const pending: Array<(error: Error) => void> = []
    const killSignals: NodeJS.Signals[] = []
    const child: CliChildHandle = {
      pid: 1,
      send() {},
      exited: new Promise(() => {}),
      kill(signal = 'SIGTERM') {
        killSignals.push(signal)
      },
    }
    const lease = {
      home: '/tmp/h',
      generation: 'g',
      assertHeld: () =>
        new Promise<void>((_resolve, reject) => {
          pending.push(reject)
        }),
    } as unknown as Parameters<typeof startLeaseWatchdog>[0]
    const watchdog = startLeaseWatchdog(lease, child, { write() {} } as never, 10)
    try {
      await new Promise((resolve) => setTimeout(resolve, 35))
      // A watchdog must keep at most one lease check in flight. Otherwise a
      // stopped watchdog can still have several stale completions to race.
      expect(pending).toHaveLength(1)
      watchdog.stop()
      const failure = Object.assign(new Error('lock disappeared'), { code: 'LEASE_CHANGED' })
      pending[0]?.(failure)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(killSignals).toEqual([])
    } finally {
      watchdog.stop()
    }
  })
})

describe('bundled CLI lease watchdog', () => {
  it('kills an authorized child when the lease disappears underneath it', async () => {
    const home = await isolatedHome()
    const stderr = new MemoryStderr()
    const killSignals: NodeJS.Signals[] = []
    let authorized = false
    let resolveExit: ((exit: { code: number | null; signal: string | null }) => void) | undefined
    const spawn: SpawnCliChild = () => {
      const handle: CliChildHandle = {
        pid: 5556,
        send(message) {
          if ((message as { kind?: string })?.kind === 'dsh-native-authorized') {
            authorized = true
          }
        },
        exited: new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          resolveExit = resolve
        }),
        kill(signal = 'SIGTERM') {
          killSignals.push(signal)
          // A killed child dies: the CLI's exit path must run to completion.
          resolveExit?.({ code: null, signal })
        },
      }
      return handle
    }
    const running = runBundledCli(['--profile', 'headless', 'task'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: spawn,
      stderr,
      watchdogIntervalMs: 20,
    }).then(() => {
      // The promise settles when the watchdog-killed child's exited promise
      // resolves; the return code is not what this test asserts.
    })
    // Wait until the child is authorized, then destroy the lease the way a
    // foreign doctor would (owner + sentinel gone).
    const deadline = Date.now() + 5_000
    while (!authorized && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(authorized).toBe(true)
    // Destroy the lease from the filesystem the way a foreign doctor would.
    const { rm: removeDir } = await import('node:fs/promises')
    await removeDir(path.join(home, 'run', 'host.lock'), { recursive: true, force: true })
    // Two watchdog failures at 20ms intervals must SIGKILL the child AND
    // the CLI call must SETTLE (never stay pending): after the kill the
    // lease is genuinely gone, so settling as a lease error is the correct
    // completion of the exit path.
    const settled = await Promise.race([
      running.then(
        (code) => `exit:${code}`,
        (error: unknown) => `error:${(error as { code?: string }).code ?? 'unknown'}`,
      ),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('CLI did not settle after the kill')), 2_000),
      ),
    ])
    expect(killSignals).toContain('SIGKILL')
    expect(stderr.text()).toContain('home lease lost')
    expect(settled.startsWith('exit:') || settled.startsWith('error:')).toBe(true)
  })
})

describe('runBundledCli', () => {
  it('refuses an incompatible home before any write-home child spawns', async () => {
    const home = await isolatedHome()
    const stderr = new MemoryStderr()
    let spawns = 0
    const spawn: SpawnCliChild = (input) => {
      spawns += 1
      return makeFakeChild(0).spawn(input)
    }
    const code = await runBundledCli(['plugin', '--profile', 'deskwork', 'add', '@example/a'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: spawn,
      stderr,
      admitHome: () => Promise.resolve('unsupported-data'),
    })
    expect(code).toBe(5)
    expect(spawns).toBe(0)
    expect(stderr.text()).toContain('newer release')
    // The lease was acquired for the diagnostic and released again: no
    // leftover lock keeps the home unusable for the next supported entry.
    await expect(statAsync(ownerPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads the real marker and fails closed on unreadable content', async () => {
    const home = await isolatedHome()
    await mkdir(path.join(home, 'run'), { recursive: true })
    await writeFile(
      path.join(home, 'run', 'compatibility.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        dataEpoch: 2,
        lastWriterReleaseId: 'future-release',
        formats: {},
      })}\n`,
      'utf8',
    )
    const stderr = new MemoryStderr()
    let spawns = 0
    const code = await runBundledCli(['plugin', '--profile', 'deskwork', 'add', '@example/a'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: (input) => {
        spawns += 1
        return makeFakeChild(0).spawn(input)
      },
      stderr,
    })
    expect(code).toBe(5)
    expect(spawns).toBe(0)
    expect(stderr.text()).toContain('newer release')

    // A corrupt marker is equally refused through the default admission.
    const corruptHome = await isolatedHome()
    await mkdir(path.join(corruptHome, 'run'), { recursive: true })
    await writeFile(path.join(corruptHome, 'run', 'compatibility.json'), '{broken', 'utf8')
    const secondCode = await runBundledCli(['--profile', 'headless', 'work'], {
      env: { DESKWORK_HOME: corruptHome },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: (input) => {
        spawns += 1
        return makeFakeChild(0).spawn(input)
      },
      stderr,
    })
    expect(secondCode).toBe(5)
    expect(spawns).toBe(0)
    expect(stderr.text()).toContain('unknown compatibility marker')
  })

  it('admits the home even for profile-less passthrough commands', async () => {
    const home = await isolatedHome()
    await mkdir(path.join(home, 'run'), { recursive: true })
    await writeFile(
      path.join(home, 'run', 'compatibility.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        dataEpoch: 2,
        lastWriterReleaseId: 'future-release',
        formats: {},
      })}\n`,
      'utf8',
    )
    const stderr = new MemoryStderr()
    let spawns = 0
    const code = await runBundledCli(['--help'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      stderr,
      spawnChild: (input) => {
        spawns += 1
        return makeFakeChild(0).spawn(input)
      },
    })
    expect(code).toBe(5)
    expect(spawns).toBe(0)
    expect(stderr.text()).toContain('newer release')
  })

  it('forwards argv verbatim and registers the child before authorizing boot', async () => {
    const home = await isolatedHome()
    const stderr = new MemoryStderr()
    const child = makeFakeChild(0)
    const sentArgv: (readonly string[])[] = []
    let ownerAtAuthorization: unknown
    const spawn: SpawnCliChild = (input) => {
      sentArgv.push([...input.argv])
      const spawned = child.spawn(input)
      return {
        ...spawned,
        send(message) {
          // Capture the owner state at the exact moment boot authorization
          // is delivered to the official CLI child.
          ownerAtAuthorization = JSON.parse(readFileSync(ownerPathOf(home), 'utf8')) as unknown
          spawned.send(message)
        },
      }
    }
    const code = await runBundledCli(
      ['plugin', '--profile', 'deskwork', 'add', '@example/a', 'with space', '--', '--patch'],
      {
        env: { DESKWORK_HOME: home },
        probe: fakeProbe,
        guard: createInProcessGuardLock(),
        spawnChild: spawn,
        stderr,
      },
    )
    expect(code).toBe(0)
    expect(sentArgv).toEqual([
      ['plugin', '--profile', 'deskwork', 'add', '@example/a', 'with space', '--', '--patch'],
    ])
    const authorization = child.forwarded()[0] as { kind: string; argv: readonly string[] }
    expect(authorization.kind).toBe('dsh-native-authorized')
    expect(authorization.argv).toEqual([
      'plugin',
      '--profile',
      'deskwork',
      'add',
      '@example/a',
      'with space',
      '--',
      '--patch',
    ])
    // The lease owner recorded this wrapper as supervisor with the resolved
    // child identity attached before boot authorization was delivered.
    expect(ownerAtAuthorization).toMatchObject({
      entrypoint: 'bundled-cli',
      profile: 'deskwork',
      host: { pid: 5555, startIdentity: 'cli-child-os' },
      pendingSpawn: false,
    })
    await expect(statAsync(ownerPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(stderr.text()).toBe('')
  })

  it('exits before forking the child when the home is busy', async () => {
    const home = await isolatedHome()
    const other = await acquireHomeLease({
      home,
      entrypoint: 'desktop',
      profile: 'deskwork',
      appVersion: '0.0.0',
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
    })
    const stderr = new MemoryStderr()
    const child = makeFakeChild(0)
    const code = await runBundledCli(['--profile', 'headless', 'do', 'work'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr,
    })
    expect(code).toBe(3)
    expect(child.forwarded()).toEqual([])
    expect(stderr.text()).toContain('HOME_BUSY')
    expect(stderr.text()).toContain('doctor --unlock')
    expect(stderr.text()).toContain('DESKWORK_HOME')
    await other.release()
  })

  it('passes unresolvable invocations through without taking the lease', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(1)
    const code = await runBundledCli([], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr: new MemoryStderr(),
    })
    expect(code).toBe(1)
    expect(child.forwarded()).toHaveLength(1)
    await expect(statAsync(ownerPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the child exit code and still releases the lease', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(7)
    const code = await runBundledCli(['--profile', 'headless', 'run'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr: new MemoryStderr(),
    })
    expect(code).toBe(7)
    await expect(statAsync(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps the lease when an unauthorized child cannot be proven dead', async () => {
    const home = await isolatedHome()
    const stderr = new MemoryStderr()
    const killSignals: NodeJS.Signals[] = []
    const spawn: SpawnCliChild = () => ({
      pid: 5556,
      send() {
        throw new Error('must never authorize an unreapable child')
      },
      exited: new Promise(() => undefined),
      kill(signal = 'SIGTERM') {
        killSignals.push(signal)
      },
    })
    const brokenProbe: ProcessProbe = {
      ...fakeProbe,
      async identify() {
        throw new Error('identity lookup failed')
      },
    }
    const code = await runBundledCli(['--profile', 'headless', 'task'], {
      env: { DESKWORK_HOME: home },
      probe: brokenProbe,
      guard: createInProcessGuardLock(),
      spawnChild: spawn,
      stderr,
    })
    expect(code).toBe(4)
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stderr.text()).toContain('keeping the home lease')
    expect(stderr.text()).toContain('doctor --unlock')
    // The lock stays on disk for doctor; nothing was confirmed or released.
    expect((await statAsync(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('waits for lingering write-home descendants before releasing the lease', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(0)
    let probes = 0
    const groupKills: string[] = []
    const code = await runBundledCli(['--profile', 'headless', 'run'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr: new MemoryStderr(),
      groupAlive: () => {
        probes += 1
        return probes <= 3
      },
      killGroup: (_pgid, signal) => {
        groupKills.push(signal)
      },
    })
    expect(code).toBe(0)
    expect(probes).toBeGreaterThan(3)
    expect(groupKills).toEqual([])
    await expect(statAsync(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps the lease when the CLI process group cannot be proven dead', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(0)
    const stderr = new MemoryStderr()
    const groupKills: string[] = []
    const code = await runBundledCli(['--profile', 'headless', 'run'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr,
      groupAlive: () => true,
      killGroup: (_pgid, signal) => {
        groupKills.push(signal)
      },
      descendantGraceMs: 50,
      descendantEscalationMs: 50,
    })
    expect(code).toBe(4)
    expect(groupKills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stderr.text()).toContain('keeping the home lease')
    expect((await statAsync(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('reaps the unauthorized child when host registration fails', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(0)
    const brokenProbe: ProcessProbe = {
      ...fakeProbe,
      async identify() {
        throw new Error('identity lookup failed')
      },
    }
    await expect(
      runBundledCli(['--profile', 'headless', 'task'], {
        env: { DESKWORK_HOME: home },
        probe: brokenProbe,
        guard: createInProcessGuardLock(),
        spawnChild: child.spawn,
        stderr: new MemoryStderr(),
      }),
    ).rejects.toThrow('identity lookup failed')
    // The fake child reports an already-resolved exit, so one terminate
    // signal is enough to prove the reap.
    expect(child.kills()).toEqual(['SIGTERM'])
    expect(child.forwarded()).toEqual([])
    await expect(statAsync(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses doctor unlock while an owner is alive and reports exit code 2', async () => {
    const home = await isolatedHome()
    const held = await acquireHomeLease({
      home,
      entrypoint: 'desktop',
      profile: 'deskwork',
      appVersion: '0.0.0',
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
    })
    const stderr = new MemoryStderr()
    const code = await runBundledCli(['doctor', '--unlock'], {
      env: { DESKWORK_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: makeFakeChild(0).spawn,
      stderr,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('ACTIVE_OWNER')
    await held.release()
  })

  it('unlocks a stale owner that provably exited', async () => {
    const home = await isolatedHome()
    const staleProbe: ProcessProbe = {
      async current() {
        return { pid: process.pid, startIdentity: 'doctor-self' }
      },
      async identify(pid) {
        return { pid, startIdentity: 'gone' }
      },
      async inspect() {
        return 'absent' as const
      },
      async scanSupported() {
        return 'none' as const
      },
    }
    const dead = await acquireHomeLease({
      home,
      entrypoint: 'bundled-cli',
      profile: 'deskwork',
      appVersion: '0.0.0',
      probe: {
        ...staleProbe,
        async current() {
          return { pid: 9101, startIdentity: 'dead-wrapper' }
        },
      },
      guard: createInProcessGuardLock(),
    })
    // Simulate the wrapper dying without releasing.
    const stderr = new MemoryStderr()
    const code = await runBundledCli(['doctor', '--unlock'], {
      env: { DESKWORK_HOME: home },
      probe: staleProbe,
      guard: createInProcessGuardLock(),
      spawnChild: makeFakeChild(0).spawn,
      stderr,
    })
    expect(code).toBe(0)
    expect(stderr.text()).toContain('unlocked')
    await expect(statAsync(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    void dead
  })
})

describe('resolvePackagedCliRuntime', () => {
  async function stagingFixture(compatibilityJson: string | undefined) {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-staged-cli-'))
    const stagingRoot = path.join(root, 'runtime-cli')
    const dshDir = path.join(stagingRoot, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(dshDir, { recursive: true })
    await writeFile(
      path.join(dshDir, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: './lib/bin.js' } })}\n`,
    )
    if (compatibilityJson !== undefined) {
      await mkdir(path.join(root, 'runtime-host'), { recursive: true })
      await writeFile(path.join(root, 'compatibility.json'), compatibilityJson)
    }
    return stagingRoot
  }

  it('resolves the staged dsh bin and the packaged desktop executable', async () => {
    const stagingRoot = await stagingFixture(
      `${JSON.stringify({ productExecutableName: 'Deskwork' })}\n`,
    )
    const runtime = resolvePackagedCliRuntime({ stagingRoot })
    const canonicalRoot = realpathSync(stagingRoot)
    expect(runtime.dshBin).toBe(
      path.join(canonicalRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    )
    expect(runtime.nodeExecutable).toBe(path.join(canonicalRoot, 'node', 'bin', 'node'))
    expect(runtime.leaseHelper).toBe(
      path.join(path.dirname(canonicalRoot), 'native', 'lease-helper'),
    )
    expect(runtime.desktopEntryExecutables[0]).toMatch(/MacOS\/Deskwork$/u)
  })

  it('fails with a reinstall diagnosis when the embedded manifest is corrupt', async () => {
    const stagingRoot = await stagingFixture('{broken json')
    expect(() => resolvePackagedCliRuntime({ stagingRoot })).toThrow(/reinstall the application/u)
    const missing = await stagingFixture(undefined)
    expect(() => resolvePackagedCliRuntime({ stagingRoot: missing })).toThrow(
      /reinstall the application/u,
    )
  })

  it('rejects a manifest that does not name the app executable', async () => {
    const stagingRoot = await stagingFixture(`${JSON.stringify({ releaseId: 'x' })}\n`)
    expect(() => resolvePackagedCliRuntime({ stagingRoot })).toThrow(
      /does not name the app executable/u,
    )
  })
})
