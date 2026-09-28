import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { HomeLease } from '@deskwork/home-lease'

import type { ProfileRef } from './profile-ref.js'
import { assertRealDirectory, writeAtomicDurable } from './durable-fs.js'

export const SAFE_PROFILE_NAME = 'desktop-safe-mode'

export const SAFE_BUNDLE_PREFIX = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deskwork/desktop-recovery-bridge',
] as const

/**
 * The exact manifest this module writes — and the only manifest an existing
 * safe profile may carry. Generation and verification share it so no field
 * can drift between them (a `patchReload: "live"` with the right bundles
 * would otherwise ride through verification into the safe boot).
 */
export function safeProfileManifest() {
  return {
    name: 'dsh-profile-desktop-safe-mode',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...SAFE_BUNDLE_PREFIX], patchReload: 'startup' } },
  }
}

/**
 * Prepare (or verify) the Safe Mode profile: exactly the three first-party
 * bundles and nothing else. Any other entry in the profile directory — a
 * local `cordis.patch.yml`, `pnpm-workspace.yaml`, `node_modules`, or any
 * unknown file — is untrusted content the safe boot must never execute, so
 * the profile reports conflict and is left untouched (the caller keeps the
 * local recovery page instead).
 */
export async function prepareSafeProfile(
  ref: ProfileRef,
  lease: HomeLease,
): Promise<'prepared' | 'conflict'> {
  if (ref.name !== SAFE_PROFILE_NAME) {
    throw new Error('prepareSafeProfile only owns the desktop-safe-mode profile')
  }
  if (lease.home !== ref.home) {
    throw new Error('safe profile preparation requires a lease bound to the home')
  }
  await lease.assertHeld()
  // The safe profile tree must be real directories: a symlinked profiles/
  // or desktop-safe-mode/ would write the manifest outside the home.
  await assertRealDirectory(path.join(ref.home, 'profiles'), 'profiles directory')
  const dirExisted = await assertRealDirectory(ref.dir, 'safe profile directory')
  if (!dirExisted) await mkdir(ref.dir, { recursive: true, mode: 0o700 })
  await assertRealDirectory(ref.dir, 'safe profile directory')
  const manifestPath = path.join(ref.dir, 'package.json')
  let existing: string | undefined
  try {
    const identity = await lstat(manifestPath)
    if (identity.isSymbolicLink()) return 'conflict'
    if (!identity.isFile()) return 'conflict'
    existing = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // The directory must hold exactly the manifest this module writes — the
  // safe boot loads whatever layers the profile directory exposes. A
  // directory that cannot even be enumerated propagates the error: the
  // caller keeps the local recovery page rather than writing beside
  // unenumerated content.
  const entries = await readdir(ref.dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  const unexpected = entries.filter((entry) => entry !== 'package.json')
  if (unexpected.length > 0) return 'conflict'
  if (existing !== undefined) {
    let manifest: unknown
    try {
      manifest = JSON.parse(existing)
    } catch {
      // An unparsable manifest is unknown user content, not an empty profile.
      return 'conflict'
    }
    // Verify the FULL controlled shape, not just the bundle list: a manifest
    // with the same bundles but `patchReload: "live"` (or any other drift in
    // the fields this module owns) must conflict — the safe boot's lifecycle
    // depends on every controlled field, and only this module may write it.
    if (JSON.stringify(manifest) !== JSON.stringify(safeProfileManifest())) {
      return 'conflict'
    }
    return 'prepared'
  }
  const manifest = `${JSON.stringify(safeProfileManifest(), undefined, 2)}\n`
  await writeAtomicDurable(manifestPath, new TextEncoder().encode(manifest))
  return 'prepared'
}
