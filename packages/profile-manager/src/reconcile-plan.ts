import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

import { PRODUCT } from '@deskwork/product-config'

import { isHomeSession, type ProfileWriteAuthority } from './reconcile.js'
import type { HomeSession } from '@deskwork/desktop-contracts/home-session'
import type { ProfileRef } from './profile-ref.js'

import {
  DESKTOP_BUNDLE_PREFIX,
  PROFILE_PATCH_TEMPLATE,
  PROFILE_WORKSPACE,
  desktopManifestTemplate,
} from './reconcile-templates.js'

export type ManagedProfilePath = 'package.json' | 'cordis.patch.yml' | 'pnpm-workspace.yaml'

export const MANAGED_PROFILE_PATHS: readonly ManagedProfilePath[] = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-workspace.yaml',
]

export type FileRevision = Readonly<{ exists: boolean; sha256: string | null }>

export type PlannedProfileWrite = Readonly<{
  path: ManagedProfilePath
  before: FileRevision
  beforeBytes: Uint8Array | null
  candidateBytes: Uint8Array
  candidateSha256: string
}>

export type ProfileReconcilePlan = Readonly<{
  ref: ProfileRef
  writes: readonly PlannedProfileWrite[]
}>

export function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Validate an authority against the profile it is about to write. */
export function asWriteAuthority(
  authority: ProfileWriteAuthority,
  ref: ProfileRef,
): HomeSession | undefined {
  if (isHomeSession(authority)) {
    if (authority.home !== ref.home) {
      throw new Error('profile write authority does not match ProfileRef home')
    }
    return authority
  }
  if (authority.kind !== 'm0-isolated-home' || authority.home !== ref.home) {
    throw new Error('profile write authority does not match ProfileRef home')
  }
  return undefined
}

type ProfileManifest = Record<string, unknown> & {
  dsh?: Record<string, unknown> & {
    profile?: Record<string, unknown> & {
      bundles?: unknown
      patchReload?: unknown
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProfileManifest(raw: string): ProfileManifest {
  const manifest: unknown = JSON.parse(raw)
  if (!isRecord(manifest)) throw new Error('desktop profile manifest must hold a JSON object')
  if (manifest.dsh !== undefined && !isRecord(manifest.dsh)) {
    throw new Error('desktop profile dsh field must hold a JSON object')
  }
  if (manifest.dsh?.profile !== undefined && !isRecord(manifest.dsh.profile)) {
    throw new Error('desktop profile field must hold a JSON object')
  }
  return manifest as ProfileManifest
}

function reconciledManifest(manifest: ProfileManifest): ProfileManifest {
  const dsh = manifest.dsh ?? {}
  const profile = dsh.profile ?? {}
  const bundles = profile.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some((bundle) => typeof bundle !== 'string')) {
    throw new Error('desktop profile bundle list must contain only package names')
  }
  if (
    profile.patchReload !== undefined &&
    profile.patchReload !== 'live' &&
    profile.patchReload !== 'startup'
  ) {
    throw new Error('desktop profile patchReload must be live or startup')
  }
  const owned = new Set<string>(DESKTOP_BUNDLE_PREFIX)
  const thirdParty = bundles.filter((bundle) => !owned.has(bundle))
  return {
    ...manifest,
    dsh: {
      ...dsh,
      profile: {
        ...profile,
        bundles: [...DESKTOP_BUNDLE_PREFIX, ...thirdParty],
        patchReload: profile.patchReload ?? 'live',
      },
    },
  }
}

async function readRevision(
  filename: string,
): Promise<{ revision: FileRevision; bytes: Uint8Array | null }> {
  try {
    const identity = await lstat(filename)
    if (identity.isSymbolicLink()) throw new Error('managed profile file must not be a symlink')
    if (!identity.isFile()) throw new Error('managed profile file must be a regular file')
    const bytes = new Uint8Array(await readFile(filename))
    return { revision: { exists: true, sha256: sha256Of(bytes) }, bytes }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { revision: { exists: false, sha256: null }, bytes: null }
  }
}

/**
 * Pure planning half of the desktop reconcile: compute exactly which managed
 * files must change and capture their current bytes and digests. Performing
 * the writes is `applyProfileTransaction`'s job, under journal control.
 */
export async function planDesktopReconcile(
  ref: ProfileRef,
  authority: ProfileWriteAuthority,
): Promise<ProfileReconcilePlan> {
  // Validates that the authority belongs to this home; the returned session
  // needs no further per-write proof.
  asWriteAuthority(authority, ref)
  if (ref.name !== PRODUCT.defaultProfileName) {
    throw new Error('planDesktopReconcile only owns the app-owned profile')
  }
  if (ref.dir !== path.join(ref.home, 'profiles', ref.name)) {
    throw new Error('ProfileRef directory does not match its home')
  }

  const templates = desktopTemplates(ref)
  const writes: PlannedProfileWrite[] = []
  const currentManifest = (await pathExists(path.join(ref.dir, 'package.json')))
    ? parseProfileManifest(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    : undefined
  const desiredManifest = `${JSON.stringify(
    currentManifest === undefined ? templates.manifest : reconciledManifest(currentManifest),
    undefined,
    2,
  )}\n`

  const candidates: readonly { path: ManagedProfilePath; bytes: Uint8Array }[] = [
    { path: 'package.json', bytes: encoder.encode(desiredManifest) },
    { path: 'cordis.patch.yml', bytes: encoder.encode(templates.patch) },
    { path: 'pnpm-workspace.yaml', bytes: encoder.encode(templates.workspace) },
  ]
  for (const candidate of candidates) {
    const filename = path.join(ref.dir, candidate.path)
    const { revision, bytes } = await readRevision(filename)
    if (revision.exists && bytes !== null && sha256Of(bytes) === sha256Of(candidate.bytes)) {
      continue
    }
    if (candidate.path === 'cordis.patch.yml' || candidate.path === 'pnpm-workspace.yaml') {
      // Initial-only files: existing user content is never replaced.
      if (revision.exists) continue
    }
    writes.push({
      path: candidate.path,
      before: revision,
      beforeBytes: bytes,
      candidateBytes: candidate.bytes,
      candidateSha256: sha256Of(candidate.bytes),
    })
  }
  return Object.freeze({ ref, writes: Object.freeze(writes) })
}

const encoder = new TextEncoder()

async function pathExists(filename: string): Promise<boolean> {
  try {
    const identity = await lstat(filename)
    if (identity.isSymbolicLink()) throw new Error('managed profile file must not be a symlink')
    if (!identity.isFile()) throw new Error('managed profile file must be a regular file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}

function desktopTemplates(ref: ProfileRef): {
  manifest: ProfileManifest
  patch: string
  workspace: string
} {
  return {
    manifest: desktopManifestTemplate(path.basename(ref.dir)) as ProfileManifest,
    patch: PROFILE_PATCH_TEMPLATE,
    workspace: PROFILE_WORKSPACE,
  }
}
