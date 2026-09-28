import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireHomeLease, createInProcessGuardLock, type ProcessProbe } from '@deskwork/home-lease'

import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

import {
  DESKTOP_BUNDLE_PREFIX,
  createIsolatedHomeAuthority,
  createProfileRef,
  reconcileDesktopProfile,
} from '../src/index.js'

const fixtures: IsolatedHomeFixture[] = []

async function testHome() {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

class SameProbe implements ProcessProbe {
  async current() {
    return { pid: process.pid, startIdentity: 'reconcile-probe' }
  }
  async identify(pid: number) {
    return { pid, startIdentity: 'reconcile-probe' }
  }
  async inspect() {
    return 'same' as const
  }
  async scanSupported() {
    return 'none' as const
  }
}

async function heldLease(home: string) {
  return acquireHomeLease({
    home,
    entrypoint: 'desktop',
    profile: 'deskwork',
    appVersion: '0.0.0',
    probe: new SameProbe(),
    guard: createInProcessGuardLock(),
  })
}

describe('reconcileDesktopProfile lease authority', () => {
  it('reconciles under a live home lease', async () => {
    const home = await testHome()
    const lease = await heldLease(home)
    const result = await reconcileDesktopProfile(createProfileRef(home, 'deskwork'), lease)
    expect(result.changed).toBe(true)
    expect(
      JSON.parse(await readFile(path.join(home, 'profiles', 'deskwork', 'package.json'), 'utf8')),
    ).toMatchObject({
      dsh: { profile: { bundles: [...DESKTOP_BUNDLE_PREFIX] } },
    })
    await lease.release()
  })

  it('refuses writes after the lease was released', async () => {
    const home = await testHome()
    const lease = await heldLease(home)
    await reconcileDesktopProfile(createProfileRef(home, 'deskwork'), lease)
    await lease.release()
    await expect(
      reconcileDesktopProfile(createProfileRef(home, 'deskwork'), lease),
    ).rejects.toThrow(/released/u)
  })

  it('rejects a plain { home, generation } literal masquerading as a lease', async () => {
    const home = await testHome()
    const fake = { home, generation: 'forged' } as unknown as Parameters<
      typeof reconcileDesktopProfile
    >[1]
    await expect(reconcileDesktopProfile(createProfileRef(home, 'deskwork'), fake)).rejects.toThrow(
      /authority/u,
    )
    const manifest = path.join(home, 'profiles', 'deskwork', 'package.json')
    await expect(readFile(manifest, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a lease bound to another home', async () => {
    const home = await testHome()
    const other = await testHome()
    const lease = await heldLease(other)
    await expect(
      reconcileDesktopProfile(createProfileRef(home, 'deskwork'), lease),
    ).rejects.toThrow(/does not match/u)
    await lease.release()
  })
})

describe('reconcileDesktopProfile', () => {
  it('does not issue isolated authority for a home outside the designated userData child', () => {
    expect(() => createIsolatedHomeAuthority('/tmp/arbitrary-home', '/tmp/desktop-data')).toThrow(
      /userData/u,
    )
  })
  it.each(['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'])(
    'rejects a managed %s symlink before reading or changing the profile',
    async (filename) => {
      const home = await testHome()
      const external = await testHome()
      const ref = createProfileRef(home, 'deskwork')
      await mkdir(ref.dir, { recursive: true })
      const target = path.join(external, filename)
      await writeFile(target, '{"private":true}\n')
      await symlink(target, path.join(ref.dir, filename))

      await expect(
        reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home, path.dirname(home))),
      ).rejects.toThrow(/symlink/u)
      expect(await readFile(target, 'utf8')).toBe('{"private":true}\n')
    },
  )

  it('initializes a missing desktop profile in an isolated home', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    const result = await reconcileDesktopProfile(
      ref,
      createIsolatedHomeAuthority(home, path.dirname(home)),
    )

    const manifest = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile).toEqual({ bundles: DESKTOP_BUNDLE_PREFIX, patchReload: 'live' })
    expect(await readFile(path.join(ref.dir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(await readFile(path.join(ref.dir, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'nodeLinker: hoisted',
    )
    expect(result.changed).toBe(true)
    expect(result.beforeRevision).toBeUndefined()
    expect(result.afterRevision).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('repairs only the owned prefix and preserves third-party order and metadata', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home, path.dirname(home)))
    const manifestPath = path.join(ref.dir, 'package.json')
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: 'custom-name',
          private: true,
          scripts: { note: 'keep-me' },
          dependencies: { third: '1.2.3' },
          dsh: {
            extension: { keep: true },
            profile: {
              bundles: [
                'third-a',
                '@deepseek-ai/dsh-web-app',
                'third-b',
                '@deskwork/desktop-plugin',
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-base',
              ],
              patchReload: 'startup',
            },
          },
        },
        undefined,
        2,
      )}\n`,
    )

    const result = await reconcileDesktopProfile(
      ref,
      createIsolatedHomeAuthority(home, path.dirname(home)),
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual([...DESKTOP_BUNDLE_PREFIX, 'third-a', 'third-b'])
    expect(manifest.dsh.profile.patchReload).toBe('startup')
    expect(manifest.dsh.extension).toEqual({ keep: true })
    expect(manifest.scripts).toEqual({ note: 'keep-me' })
    expect(manifest.dependencies).toEqual({ third: '1.2.3' })
    expect(result.changed).toBe(true)
    expect(result.beforeRevision).not.toBe(result.afterRevision)
  })

  it('is idempotent and leaves unrelated profiles unchanged', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    const unrelated = createProfileRef(home, 'web')
    await mkdir(unrelated.dir, { recursive: true })
    const unrelatedPath = path.join(unrelated.dir, 'package.json')
    await writeFile(unrelatedPath, '{"name":"unrelated"}\n')
    const unrelatedBefore = await readFile(unrelatedPath, 'utf8')

    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home, path.dirname(home)))
    const second = await reconcileDesktopProfile(
      ref,
      createIsolatedHomeAuthority(home, path.dirname(home)),
    )

    expect(second.changed).toBe(false)
    expect(second.beforeRevision).toBe(second.afterRevision)
    expect(await readFile(unrelatedPath, 'utf8')).toBe(unrelatedBefore)
  })

  it('rejects write authority for another home before creating files', async () => {
    const home = await testHome()
    const otherHome = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    await expect(
      reconcileDesktopProfile(ref, createIsolatedHomeAuthority(otherHome, path.dirname(otherHome))),
    ).rejects.toThrow(/authority/u)
    await expect(readFile(path.join(ref.dir, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a desktop profile symlink before writing outside the isolated home', async () => {
    const home = await testHome()
    const external = await testHome()
    const ref = createProfileRef(home, 'deskwork')
    await mkdir(path.dirname(ref.dir), { recursive: true })
    await symlink(external, ref.dir, 'dir')

    await expect(
      reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home, path.dirname(home))),
    ).rejects.toThrow(/symlink/u)
    await expect(readFile(path.join(external, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects an isolated home symlink before profile initialization', async () => {
    const parent = await testHome()
    const external = await testHome()
    const linkedHome = path.join(parent, 'm0-dsh-home')
    await symlink(external, linkedHome, 'dir')
    const ref = createProfileRef(linkedHome, 'deskwork')

    await expect(
      reconcileDesktopProfile(
        ref,
        createIsolatedHomeAuthority(linkedHome, path.dirname(linkedHome)),
      ),
    ).rejects.toThrow(/isolated home.*symlink/u)
    await expect(
      readFile(path.join(external, 'profiles', 'deskwork', 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
