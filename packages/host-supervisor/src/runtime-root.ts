import type { Stats } from 'node:fs'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

import { RESERVED_PROFILE_NAME_PREFIX } from '@deskwork/desktop-contracts/profile-name'

export type RuntimeRoot = Readonly<{ dir: string; remove(): Promise<void> }>

async function directoryIdentity(dirname: string): Promise<Stats> {
  const identity = await lstat(dirname)
  if (identity.isSymbolicLink()) throw new Error('Host runtime directory must not be a symlink')
  if (!identity.isDirectory()) throw new Error('Host runtime path must be a directory')
  return identity
}

function sameIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino
}

/** Own only this newly created launch root, never a later replacement at its path. */
export async function createRuntimeRoot(home: string): Promise<RuntimeRoot> {
  const homeIdentity = await directoryIdentity(home)
  const profiles = path.join(home, 'profiles')
  const profilesIdentity = await directoryIdentity(profiles)
  const canonicalHome = await realpath(home)
  const canonicalProfiles = await realpath(profiles)
  if (canonicalProfiles !== path.join(canonicalHome, 'profiles')) {
    throw new Error('Host runtime parent escaped the shared home')
  }
  // Single source for the prefix: the lease gate and the format inspection
  // exempt/forbid exactly this namespace, so the mkdtemp template must be the
  // shared constant, not a lookalike literal.
  const dir = await mkdtemp(path.join(canonicalProfiles, RESERVED_PROFILE_NAME_PREFIX))
  const rootIdentity = await directoryIdentity(dir)
  let removed = false
  return Object.freeze({
    dir,
    async remove() {
      if (removed) return
      if (
        !sameIdentity(homeIdentity, await directoryIdentity(home)) ||
        !sameIdentity(profilesIdentity, await directoryIdentity(profiles)) ||
        !sameIdentity(rootIdentity, await directoryIdentity(dir)) ||
        (await realpath(profiles)) !== canonicalProfiles ||
        (await realpath(dir)) !== dir
      ) {
        throw new Error('Host runtime directory identity changed; refusing cleanup')
      }
      await rm(dir, { recursive: true })
      removed = true
    },
  })
}
