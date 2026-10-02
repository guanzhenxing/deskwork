import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHomeSession, type HomeSession } from '@deskwork/desktop-contracts/home-session'
import { createProfileRef } from '../src/index.js'
import { SAFE_BUNDLE_PREFIX, SAFE_PROFILE_NAME, prepareSafeProfile } from '../src/safe-profile.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const fixtures: IsolatedHomeFixture[] = []

async function leasedHome(): Promise<{
  ref: ReturnType<typeof createProfileRef>
  session: HomeSession
  normalDir: string
}> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const session = await createHomeSession({ home: fixture.home, profile: 'desktop' })
  return {
    ref: createProfileRef(fixture.home, SAFE_PROFILE_NAME),
    session,
    normalDir: path.join(fixture.home, 'profiles', 'desktop'),
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe('prepareSafeProfile', () => {
  it('creates exactly the three first-party bundles and never touches the normal profile', async () => {
    const { ref, session, normalDir } = await leasedHome()
    await mkdir(normalDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(normalDir, 'user.txt'), 'keep')
    await expect(prepareSafeProfile(ref, session)).resolves.toBe('prepared')
    const manifest = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual([...SAFE_BUNDLE_PREFIX])
    await expect(readFile(path.join(normalDir, 'user.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('refuses names other than desktop-safe-mode', async () => {
    const { session, ref } = await leasedHome()
    const other = createProfileRef(ref.home, 'desktop')
    await expect(prepareSafeProfile(other, session)).rejects.toThrow(/desktop-safe-mode/u)
  })

  it('never overwrites unknown user content in the safe profile', async () => {
    const { ref, session } = await leasedHome()
    await prepareSafeProfile(ref, session)
    const manifestPath = path.join(ref.dir, 'package.json')
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
    raw.dsh.profile.bundles.push('@fixture/third-party')
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`)
    await expect(prepareSafeProfile(ref, session)).resolves.toBe('conflict')
    const after = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(after.dsh.profile.bundles).toContain('@fixture/third-party')
  })

  it('refuses a manifest with the right bundles but a drifted controlled field', async () => {
    // Regression: verification compared only dsh.profile.bundles, so a
    // `patchReload: "live"` (or missing) manifest rode through into the safe
    // boot, changing its startup-only lifecycle.
    const { ref, session } = await leasedHome()
    await prepareSafeProfile(ref, session)
    const manifestPath = path.join(ref.dir, 'package.json')
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'))

    raw.dsh.profile.patchReload = 'live'
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`)
    await expect(prepareSafeProfile(ref, session)).resolves.toBe('conflict')

    delete raw.dsh.profile.patchReload
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`)
    await expect(prepareSafeProfile(ref, session)).resolves.toBe('conflict')
  })

  it('treats an unparsable manifest as unknown user content, not an empty profile', async () => {
    const { ref, session } = await leasedHome()
    await mkdir(ref.dir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(ref.dir, 'package.json'), 'not json at all', { mode: 0o600 })
    await expect(prepareSafeProfile(ref, session)).resolves.toBe('conflict')
    expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8')).toBe('not json at all')
  })

  it('refuses to follow a symlinked safe-profile manifest', async () => {
    const { ref, session } = await leasedHome()
    const outside = path.join(ref.home, '..', 'safe-manifest-outside.json')
    await writeFile(outside, '{}\n', { mode: 0o600 })
    await mkdir(ref.dir, { recursive: true, mode: 0o700 })
    await symlink(outside, path.join(ref.dir, 'package.json'), 'file')
    await expect(prepareSafeProfile(ref, session)).resolves.toBe('conflict')
    await expect(readFile(outside, 'utf8')).resolves.toBe('{}\n')
  })

  it('refuses a symlinked profiles root or safe-profile directory', async () => {
    const { ref, session } = await leasedHome()
    const outside = path.join(ref.home, '..', 'safe-outside')
    await mkdir(outside, { recursive: true, mode: 0o700 })
    await mkdir(path.join(ref.home, 'profiles'), { recursive: true, mode: 0o700 })
    // The safe profile directory itself is a symlink out of the home.
    await symlink(outside, ref.dir, 'dir')
    await expect(prepareSafeProfile(ref, session)).rejects.toThrow(/symlink/u)
    const entries = await (await import('node:fs/promises')).readdir(outside)
    expect(entries).toHaveLength(0)
  })

  it('refuses any directory content beyond the manifest it writes', async () => {
    const { ref, session } = await leasedHome()
    await prepareSafeProfile(ref, session)
    // A local patch, a workspace file, or a dependency tree are all content
    // the safe boot could execute: conflict, never overwrite or delete.
    for (const [name, kind] of [
      ['cordis.patch.yml', 'file'],
      ['node_modules', 'dir'],
    ] as const) {
      const target = path.join(ref.dir, name)
      if (kind === 'file') await writeFile(target, '# injected\n')
      else await mkdir(target, { recursive: true })
      await expect(prepareSafeProfile(ref, session)).resolves.toBe('conflict')
      if (kind === 'file') {
        await expect(readFile(target, 'utf8')).resolves.toBe('# injected\n')
        await rm(target)
      } else {
        await expect(stat(target)).resolves.toBeTruthy()
        await rm(target, { recursive: true })
      }
    }
    // With the directory back to manifest-only, verification succeeds again.
    await expect(prepareSafeProfile(ref, session)).resolves.toBe('prepared')
  })
})
