import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { initProfile, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'

import {
  createEnvelopeWriter,
  parseHostEnvelope,
  type LauncherEnvelope,
} from '@dsh-desktop/desktop-contracts/host-control'
import {
  createIsolatedHomeAuthority,
  createProfileRef,
  reconcileDesktopProfile,
} from '@dsh-desktop/profile-manager'

import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'
import {
  acquireHomeLease,
  createNativeProcessProbe,
  resolveLeaseHelperPath,
} from '@dsh-desktop/home-lease'
import { runDshHost, type HostControlTransport } from '../src/host-runner.js'
import { HostSupervisor, type HostBootstrap, type ManagedHostProcess } from '../src/supervisor.js'

const fixtures: IsolatedHomeFixture[] = []

async function testHome(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

class LoopbackTransport implements HostControlTransport {
  readonly messages: unknown[] = []
  #listener: ((message: unknown) => void) | undefined
  readonly #launcherWriter

  constructor(
    readonly capability: string,
    readonly leaseGeneration: string,
  ) {
    this.#launcherWriter = createEnvelopeWriter('launcher-to-host', capability, leaseGeneration)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
    const envelope = parseHostEnvelope(message)
    if (envelope.message.kind === 'hello') {
      queueMicrotask(() =>
        this.emit(this.#launcherWriter.next({ kind: 'accept', selectedMinor: 0 })),
      )
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#listener = listener
    return () => {
      this.#listener = undefined
    }
  }

  emit(message: LauncherEnvelope): void {
    this.#listener?.(message)
  }

  dispose(reason: 'quit' | 'restart' | 'profile-switch' | 'update' = 'quit'): void {
    this.emit(this.#launcherWriter.next({ kind: 'dispose', reason, deadlineMs: 5_000 }))
  }
}

class NodeManagedHostProcess implements ManagedHostProcess {
  readonly pid: number
  readonly startIdentity: string
  readonly #child: ChildProcess

  constructor(child: ChildProcess, startIdentity: string) {
    if (child.pid === undefined) throw new Error('forked Host has no PID')
    this.#child = child
    this.pid = child.pid
    this.startIdentity = startIdentity
  }

  deliverBootstrap(bootstrap: HostBootstrap): void {
    this.#child.send({ ...bootstrap, startIdentity: this.startIdentity })
  }

  postMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      throw new Error('Node Host test transport accepts only structured messages')
    }
    this.#child.send(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#child.on('message', listener)
    return () => this.#child.off('message', listener)
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    this.#child.on('exit', listener)
    return () => this.#child.off('exit', listener)
  }

  terminate(): void {
    this.#child.kill('SIGTERM')
  }

  kill(): void {
    this.#child.kill('SIGKILL')
  }
}

async function readOfficialBootGraph(surfaceUrl: string): Promise<{
  entries: { id: string }[]
  batches: { phase: string; entries: string[] }[]
}> {
  const login = await fetch(surfaceUrl, { redirect: 'manual' })
  expect([302, 303]).toContain(login.status)
  const location = login.headers.get('location')
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
  if (location === null || cookie === undefined)
    throw new Error('authenticated surface did not establish a session')
  const page = await fetch(new URL(location, surfaceUrl), { headers: { cookie } })
  expect(page.status).toBe(200)
  const html = await page.text()
  const bootMatch = /globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/u.exec(html)
  if (bootMatch?.[1] === undefined) throw new Error('official page did not inject a boot graph')
  return JSON.parse(bootMatch[1]) as {
    entries: { id: string }[]
    batches: { phase: string; entries: string[] }[]
  }
}

function expectCompleteOfficialBootGraph(
  bootGraph: Awaited<ReturnType<typeof readOfficialBootGraph>>,
): void {
  expect(bootGraph.entries.map((entry) => entry.id)).toContain('@deepseek-ai/dsh-client-modules')
  expect(bootGraph.entries.map((entry) => entry.id)).toContain('@deepseek-ai/dsh-client-ui-sidebar')
  expect(bootGraph.batches).toContainEqual(
    expect.objectContaining({
      phase: 'bootstrap',
      entries: expect.arrayContaining(['@deepseek-ai/dsh-client-modules']),
    }),
  )
}

describe('real DSH Host runner', () => {
  it('loads a profile-local bundle by its bare package name without mutating the profile', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home, path.dirname(home)))
    const bundle = path.join(ref.dir, 'node_modules', '@fixture', 'local-bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(
      path.join(bundle, 'package.json'),
      JSON.stringify({
        name: '@fixture/local-bundle',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        dsh: { bundle: { patch: 'bundle.patch.yml' } },
      }),
    )
    await writeFile(
      path.join(bundle, 'bundle.patch.yml'),
      '- insert:\n    - id: local-bundle\n      name: "@fixture/local-bundle"\n',
    )
    const marker = path.join(home, 'local-bundle-loaded')
    await writeFile(
      path.join(bundle, 'index.js'),
      `import { writeFileSync } from 'node:fs';\nexport const name = 'local-bundle';\nexport function apply() { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }\n`,
    )
    const manifestPath = path.join(ref.dir, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles.push('@fixture/local-bundle')
    const manifestBefore = JSON.stringify(manifest)
    await writeFile(manifestPath, manifestBefore)
    const entriesBefore = (await readdir(ref.dir)).sort()
    const host = await runDshHost({
      home,
      profileName: 'deskwork',
      mode: 'normal',
      capability: 'c'.repeat(43),
      leaseGeneration: 'lease-generation-1',
      hostIdentity: { pid: process.pid, startIdentity: 'integration-host' },
      transport: new LoopbackTransport('c'.repeat(43), 'lease-generation-1'),
    })
    try {
      expect(await readFile(marker, 'utf8')).toBe('loaded')
      expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
      expect((await readdir(ref.dir)).sort()).toEqual(entriesBefore)
    } finally {
      await host.dispose()
    }
  })

  it('keeps initialized profile files compatible with the pinned public DSH format', async () => {
    const home = await testHome()
    const upstreamHome = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    const upstreamDir = path.join(upstreamHome, 'profiles', 'desktop')
    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home, path.dirname(home)))
    initProfile(upstreamDir, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@dsh-desktop/desktop-plugin',
    ])
    // Upstream's extra comments are not part of the patch format contract.
    expect(loadOptionalPatches('parity', path.join(ref.dir, 'cordis.patch.yml'))).toEqual(
      loadOptionalPatches('parity', path.join(upstreamDir, 'cordis.patch.yml')),
    )
    for (const filename of ['package.json', 'pnpm-workspace.yaml']) {
      expect(await readFile(path.join(ref.dir, filename), 'utf8')).toBe(
        await readFile(path.join(upstreamDir, filename), 'utf8'),
      )
    }
  })

  it('rejects a profiles symlink before materializing any fallback', async () => {
    const home = await testHome()
    const external = await testHome()
    await symlink(external, path.join(home, 'profiles'), 'dir')
    await expect(
      runDshHost({
        home,
        profileName: 'deskwork',
        mode: 'normal',
        capability: 'c'.repeat(43),
        leaseGeneration: 'lease-generation-1',
        hostIdentity: { pid: process.pid, startIdentity: 'integration-host' },
        transport: new LoopbackTransport('c'.repeat(43), 'lease-generation-1'),
      }),
    ).rejects.toThrow(/symlink/u)
    expect(await readdir(external)).toEqual([])
  })

  it('refuses to delete a replacement launch root during disposal', async () => {
    const home = await testHome()
    await reconcileDesktopProfile(
      createProfileRef(home, 'deskwork'),
      createIsolatedHomeAuthority(home, path.dirname(home)),
    )
    const host = await runDshHost({
      home,
      profileName: 'deskwork',
      mode: 'normal',
      capability: 'c'.repeat(43),
      leaseGeneration: 'lease-generation-1',
      hostIdentity: { pid: process.pid, startIdentity: 'integration-host' },
      transport: new LoopbackTransport('c'.repeat(43), 'lease-generation-1'),
    })
    const profiles = path.join(home, 'profiles')
    const name = (await readdir(profiles)).find((entry) => entry.startsWith('.dsh-desktop-run-'))!
    const root = path.join(profiles, name)
    await rename(root, path.join(profiles, 'saved-root'))
    await mkdir(root)
    await writeFile(path.join(root, 'sentinel'), 'keep')
    await expect(host.dispose()).rejects.toThrow(/identity/u)
    expect(await readFile(path.join(root, 'sentinel'), 'utf8')).toBe('keep')
  })

  it('boots the desktop profile and publishes an authenticated official Web surface', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home, path.dirname(home)))
    const profileEntries = (await readdir(ref.dir)).sort()
    const capability = 'c'.repeat(43)
    const leaseGeneration = 'lease-generation-1'
    const transport = new LoopbackTransport(capability, leaseGeneration)

    const host = await runDshHost({
      home,
      profileName: 'deskwork',
      mode: 'normal',
      capability,
      leaseGeneration,
      hostIdentity: { pid: process.pid, startIdentity: 'integration-host' },
      transport,
    })

    const envelopes = transport.messages.map((message) => parseHostEnvelope(message))
    expect(envelopes.map((envelope) => envelope.message.kind)).toEqual([
      'hello',
      'phase',
      'phase',
      'surface',
      'ready',
    ])
    const surfaceMessage = envelopes.find(
      (envelope) => envelope.message.kind === 'surface',
    )?.message
    expect(surfaceMessage).toMatchObject({
      kind: 'surface',
      purpose: 'normal',
      surface: { kind: 'loopback' },
    })
    if (surfaceMessage?.kind !== 'surface') throw new Error('surface was not published')
    expectCompleteOfficialBootGraph(await readOfficialBootGraph(surfaceMessage.surface.url))
    expect((await readdir(ref.dir)).sort()).toEqual(profileEntries)
    await expect(readFile(path.join(ref.dir, 'cordis.yml'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(
      (await readdir(path.join(home, 'profiles'))).filter((name) =>
        name.startsWith('.dsh-desktop-run-'),
      ),
    ).toHaveLength(1)

    transport.dispose()
    await vi.waitFor(() => {
      expect(
        transport.messages.map((message) => parseHostEnvelope(message).message.kind),
      ).toContain('dispose-ack')
    })
    await host.disposed
    expect(
      (await readdir(path.join(home, 'profiles'))).filter((name) =>
        name.startsWith('.dsh-desktop-run-'),
      ),
    ).toEqual([])
  }, 60_000)

  it('boots the complete official Web graph from an independent Node Host process', async () => {
    const home = await testHome()
    await reconcileDesktopProfile(
      createProfileRef(home, 'deskwork'),
      createIsolatedHomeAuthority(home, path.dirname(home)),
    )
    const probe = createNativeProcessProbe({
      helperPath: resolveLeaseHelperPath(process.env),
      entryExecutables: [],
    })
    const lease = await acquireHomeLease({
      home,
      entrypoint: 'desktop',
      profile: 'desktop',
      appVersion: '0.0.0',
      probe,
    })
    let child: ChildProcess | undefined
    const supervisor = new HostSupervisor({
      stabilityMs: 0,
      startupTimeoutMs: 30_000,
      factory: {
        async spawnWaiting(): Promise<ManagedHostProcess> {
          const startIdentity = randomUUID()
          child = fork(fileURLToPath(new URL('./fixtures/node-host.mjs', import.meta.url)), [], {
            cwd: fileURLToPath(new URL('../../../apps/desktop-launcher', import.meta.url)),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          })
          return new NodeManagedHostProcess(child, startIdentity)
        },
      },
    })

    const ready = await supervisor.start({
      home,
      profileName: 'deskwork',
      mode: 'normal',
      lease,
      probe,
    })
    expect(ready.pid).not.toBe(process.pid)
    expectCompleteOfficialBootGraph(await readOfficialBootGraph(ready.surface.url))

    await supervisor.stop('quit', 5_000)
    await vi.waitFor(() => expect(child?.exitCode).toBe(0))
    await lease.release()
  }, 60_000)

  it('boots the rc.1 Host with the narrow loopback ready contract', async () => {
    const home = await testHome()
    await reconcileDesktopProfile(
      createProfileRef(home, 'deskwork'),
      createIsolatedHomeAuthority(home, path.dirname(home)),
    )
    const probe = createNativeProcessProbe({
      helperPath: resolveLeaseHelperPath(process.env),
      entryExecutables: [],
    })
    const lease = await acquireHomeLease({
      home,
      entrypoint: 'desktop',
      profile: 'desktop',
      appVersion: '0.0.0',
      probe,
    })
    let child: ChildProcess | undefined
    const supervisor = new HostSupervisor({
      stabilityMs: 0,
      startupTimeoutMs: 30_000,
      factory: {
        async spawnWaiting(): Promise<ManagedHostProcess> {
          const startIdentity = randomUUID()
          child = fork(fileURLToPath(new URL('./fixtures/node-host.mjs', import.meta.url)), [], {
            cwd: fileURLToPath(new URL('../../../apps/desktop-launcher', import.meta.url)),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          })
          return new NodeManagedHostProcess(child, startIdentity)
        },
      },
    })

    const ready = await supervisor.start({
      home,
      profileName: 'deskwork',
      mode: 'normal',
      lease,
      probe,
    })
    expect(ready.surface.url).toMatch(/^http:\/\/127\.0\.0\.1:/u)
    expect(ready.surface.kind).toBe('loopback')
    expect(ready.origin).toMatch(/^http:\/\/127\.0\.0\.1:/u)
    expect(ready.pid).toBeGreaterThan(0)

    await supervisor.stop('quit', 5_000)
    await vi.waitFor(() => expect(child?.exitCode).toBe(0))
    await lease.release()
  }, 60_000)
})
