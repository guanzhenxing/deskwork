import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  defaultLeaseHelperPath,
} from '@deskwork/home-lease'

import { createProfileRef } from '@deskwork/profile-manager'
import { prepareSafeProfile, SAFE_PROFILE_NAME } from '@deskwork/profile-manager'
import { createEnvelopeWriter, parseHostEnvelope } from '@deskwork/desktop-contracts/host-control'
import { runDshHost, type HostControlTransport } from '../src/host-runner.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const helperAvailable =
  process.platform === 'darwin' &&
  spawnSync(defaultLeaseHelperPath(), ['identity', String(process.pid)], { timeout: 5_000 })
    .status === 0

const fixtures: IsolatedHomeFixture[] = []

async function leasedHome() {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const lease = await acquireHomeLease({
    home: fixture.home,
    entrypoint: 'desktop',
    profile: SAFE_PROFILE_NAME,
    appVersion: '0.0.0',
    probe: createNativeProcessProbe({
      helperPath: defaultLeaseHelperPath(),
      entryExecutables: [],
    }),
  })
  return { fixture, lease }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe.skipIf(!helperAvailable)('safe mode boot', () => {
  it('boots the safe profile with recovery surface purpose and rejects the reverse combination', async () => {
    const { fixture, lease } = await leasedHome()
    const ref = createProfileRef(fixture.home, SAFE_PROFILE_NAME)
    await expect(prepareSafeProfile(ref, lease)).resolves.toBe('prepared')
    // The install anchor must be a real package manifest (healed fallbacks).
    const anchor = path.join(fixture.userData, 'anchor.json')
    await copyFile(fileURLToPath(new URL('../package.json', import.meta.url)), anchor)
    // Project our workspace recovery bridge into the safe profile so the
    // pinned bundle resolver finds it (same mechanism as the local-bundle test).
    const bridgeRoot = fileURLToPath(new URL('../../desktop-recovery-bridge', import.meta.url))
    const bridgeLink = path.join(ref.dir, 'node_modules', '@deskwork', 'desktop-recovery-bridge')
    await mkdir(path.dirname(bridgeLink), { recursive: true })
    await symlink(bridgeRoot, bridgeLink, 'dir')

    const transport = buildTransport(lease.generation)
    const host = await runDshHost({
      home: fixture.home,
      profileName: SAFE_PROFILE_NAME,
      mode: 'safe',
      capability: 'c'.repeat(43),
      leaseGeneration: lease.generation,
      hostIdentity: { pid: process.pid, startIdentity: 'safe-integration' },
      transport: transport.transport,
      installAnchor: path.join(fixture.userData, 'anchor.json'),
    })
    const kinds = transport.messages.map(
      (m) => (m as { message?: { kind?: string } }).message?.kind,
    )
    expect(kinds).toContain('ready')
    const surface = transport.messages.find(
      (m) => (m as { message?: { kind?: string } }).message?.kind === 'surface',
    ) as { message: { purpose: string } }
    expect(surface.message.purpose).toBe('recovery')
    await host.dispose()

    await expect(
      runDshHost({
        home: fixture.home,
        profileName: SAFE_PROFILE_NAME,
        mode: 'normal',
        capability: 'c'.repeat(43),
        leaseGeneration: lease.generation,
        hostIdentity: { pid: process.pid, startIdentity: 'safe-integration' },
        transport: buildTransport(lease.generation).transport,
        installAnchor: path.join(fixture.userData, 'anchor.json'),
      }),
    ).rejects.toThrow(/boot profile invalid/u)
    await lease.release()
  })

  it('keeps a corrupted normal profile untouched by safe mode', async () => {
    const { fixture, lease } = await leasedHome()
    const normalDir = path.join(fixture.home, 'profiles', 'deskwork')
    await mkdir(normalDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(normalDir, 'package.json'), '{corrupt', 'utf8')
    const ref = createProfileRef(fixture.home, SAFE_PROFILE_NAME)
    await expect(prepareSafeProfile(ref, lease)).resolves.toBe('prepared')
    expect(await readFile(path.join(normalDir, 'package.json'), 'utf8')).toBe('{corrupt')
    await lease.release()
  })

  it('fails safe mode on a corrupted home patch without rewriting it', async () => {
    const { fixture, lease } = await leasedHome()
    const ref = createProfileRef(fixture.home, SAFE_PROFILE_NAME)
    await expect(prepareSafeProfile(ref, lease)).resolves.toBe('prepared')
    // Safe mode keeps the shared home patch semantics: a broken home patch
    // also breaks safe mode — never silently ignored or rewritten.
    const homePatch = path.join(fixture.home, 'cordis.patch.yml')
    await writeFile(homePatch, '{ not a patch list', { mode: 0o600 })
    const anchor = path.join(fixture.userData, 'anchor.json')
    await copyFile(fileURLToPath(new URL('../package.json', import.meta.url)), anchor)
    await expect(
      runDshHost({
        home: fixture.home,
        profileName: SAFE_PROFILE_NAME,
        mode: 'safe',
        capability: 'c'.repeat(43),
        leaseGeneration: lease.generation,
        hostIdentity: { pid: process.pid, startIdentity: 'safe-home-patch' },
        transport: buildTransport(lease.generation).transport,
        installAnchor: anchor,
      }),
    ).rejects.toThrow()
    expect(await readFile(homePatch, 'utf8')).toBe('{ not a patch list')
    await lease.release()
  })

  it('never loads profile-local patches during a safe boot', async () => {
    const { fixture, lease } = await leasedHome()
    const ref = createProfileRef(fixture.home, SAFE_PROFILE_NAME)
    // Hand-build the safe profile with a poisoned local patch (mirroring a
    // directory prepareSafeProfile would refuse; the runner must enforce the
    // same boundary independently of the launcher).
    await mkdir(ref.dir, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(ref.dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-desktop-safe-mode',
          private: true,
          dependencies: {},
          dsh: {
            profile: {
              bundles: [
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-web-app',
                '@deskwork/desktop-recovery-bridge',
              ],
              patchReload: 'startup',
            },
          },
        },
        undefined,
        2,
      )}\n`,
    )
    await writeFile(
      path.join(ref.dir, 'cordis.patch.yml'),
      // Unparseable on purpose: with userLayer:false the safe boot must not
      // even READ this file — neither parsing nor composing it can fail.
      '{ not a patch list',
      'utf8',
    )
    const anchor = path.join(fixture.userData, 'anchor.json')
    await copyFile(fileURLToPath(new URL('../package.json', import.meta.url)), anchor)
    const bridgeRoot = fileURLToPath(new URL('../../desktop-recovery-bridge', import.meta.url))
    const bridgeLink = path.join(ref.dir, 'node_modules', '@deskwork', 'desktop-recovery-bridge')
    await mkdir(path.dirname(bridgeLink), { recursive: true })
    await symlink(bridgeRoot, bridgeLink, 'dir')

    const transport = buildTransport(lease.generation)
    const host = await runDshHost({
      home: fixture.home,
      profileName: SAFE_PROFILE_NAME,
      mode: 'safe',
      capability: 'c'.repeat(43),
      leaseGeneration: lease.generation,
      hostIdentity: { pid: process.pid, startIdentity: 'safe-patch-boundary' },
      transport: transport.transport,
      installAnchor: anchor,
    })
    const kinds = transport.messages.map(
      (m) => (m as { message?: { kind?: string } }).message?.kind,
    )
    expect(kinds).toContain('ready')
    await host.dispose()
    await lease.release()
  })
})

function buildTransport(generation: string) {
  const messages: unknown[] = []
  let listener: ((m: unknown) => void) | undefined
  const writer = createEnvelopeWriter('launcher-to-host', 'c'.repeat(43), generation)
  const transport: HostControlTransport = {
    postMessage(message) {
      messages.push(message)
      const envelope = parseHostEnvelope(message)
      if (envelope.message.kind === 'hello') {
        queueMicrotask(() => listener?.(writer.next({ kind: 'accept', selectedMinor: 0 })))
      }
    },
    onMessage(l) {
      listener = l
      return () => {
        listener = undefined
      }
    },
  }
  return { messages, transport }
}
