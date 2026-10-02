import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { PRODUCT } from '@deskwork/product-config'

import {
  createHomeSession,
  isHomeSession,
  type HomeSession,
} from '@deskwork/desktop-contracts/home-session'

import { planDesktopReconcile } from './reconcile-plan.js'
import { applyProfileTransaction } from './revision-transaction.js'

export { isHomeSession }

import type { ProfileRef } from './profile-ref.js'

import { DESKTOP_BUNDLE_PREFIX } from './reconcile-templates.js'
export { DESKTOP_BUNDLE_PREFIX }

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const authorityBrand = Symbol('ProfileWriteAuthority')

export type IsolatedHomeAuthority = Readonly<{
  kind: 'm0-isolated-home'
  home: string
  [authorityBrand]: true
}>

/** Either the isolated smoke authority or this run's home session. */
export type ProfileWriteAuthority = IsolatedHomeAuthority | HomeSession

export type ReconcileResult = Readonly<{
  ref: ProfileRef
  changed: boolean
  changedFiles: readonly string[]
  beforeRevision: string | undefined
  afterRevision: string
  transactionId?: string
}>

export function createIsolatedHomeAuthority(home: string, userData: string): IsolatedHomeAuthority {
  if (home.trim() === '') throw new Error('Profile write authority requires an explicit home')
  if (!path.isAbsolute(userData) || path.resolve(home) !== path.join(userData, 'm0-dsh-home')) {
    throw new Error('M0 profile authority requires the designated userData/m0-dsh-home')
  }
  return Object.freeze({
    kind: 'm0-isolated-home' as const,
    home: path.resolve(home),
    [authorityBrand]: true as const,
  })
}

async function requireOwnedDirectory(dirname: string, label: string): Promise<void> {
  let current
  try {
    current = await lstat(dirname)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(dirname, { mode: 0o700 })
    current = await lstat(dirname)
  }
  if (current.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
  if (!current.isDirectory()) throw new Error(`${label} must be a directory`)
}

async function ensureContainedProfileDirectory(ref: ProfileRef): Promise<void> {
  const expectedDir = path.join(ref.home, 'profiles', ref.name)
  if (ref.dir !== expectedDir) throw new Error('ProfileRef directory does not match its home')
  await requireOwnedDirectory(ref.home, 'isolated home')
  await requireOwnedDirectory(path.join(ref.home, 'profiles'), 'profiles directory')
  await requireOwnedDirectory(ref.dir, 'profile directory')
  const [canonicalHome, canonicalProfile] = await Promise.all([
    realpath(ref.home),
    realpath(ref.dir),
  ])
  const relativeProfile = path.relative(canonicalHome, canonicalProfile)
  if (
    relativeProfile === '' ||
    relativeProfile === '..' ||
    relativeProfile.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeProfile)
  ) {
    throw new Error('profile directory escapes the isolated home')
  }
}

export async function reconcileDesktopProfile(
  ref: ProfileRef,
  authority: ProfileWriteAuthority,
): Promise<ReconcileResult> {
  if (ref.name !== PRODUCT.defaultProfileName)
    throw new Error('reconcileDesktopProfile only owns the app-owned profile')

  if (isHomeSession(authority)) {
    if (authority.home !== ref.home) {
      throw new Error('profile write authority does not match ProfileRef home')
    }
    return reconcileUnderSession(ref, authority)
  }
  if (
    authority[authorityBrand] !== true ||
    authority.kind !== 'm0-isolated-home' ||
    authority.home !== ref.home
  ) {
    throw new Error('profile write authority does not match ProfileRef home')
  }
  // The isolated authority authorizes the write; it does not select a second
  // write path. Smoke homes go through the same journaled reconcile as the
  // real one, so the isolated path exercises production behaviour.
  return reconcileUnderSession(ref, createHomeSession({ home: authority.home, profile: ref.name }))
}

/** Reconcile failure tagged with where it happened, for launcher-side attribution. */
export class ProfileReconcileError extends Error {
  constructor(
    readonly phase: 'plan' | 'apply',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ProfileReconcileError'
  }
}

/** Shared-home reconcile: plan, apply as a journaled revision transaction. */
async function reconcileUnderSession(
  ref: ProfileRef,
  session: HomeSession,
): Promise<ReconcileResult> {
  try {
    await ensureContainedProfileDirectory(ref)
  } catch (cause) {
    throw new ProfileReconcileError('plan', cause)
  }
  let plan
  try {
    plan = await planDesktopReconcile(ref, session)
  } catch (cause) {
    throw new ProfileReconcileError('plan', cause)
  }
  const manifestWrite = plan.writes.find((write) => write.path === 'package.json')
  let transactionId: string | undefined
  if (plan.writes.length > 0) {
    let tx
    try {
      tx = await applyProfileTransaction(plan, session)
    } catch (cause) {
      throw new ProfileReconcileError('apply', cause)
    }
    // A transaction that ended in conflict left the journal — and possibly
    // some files — mid-flight; never hand it back as a bootable pending
    // transaction. The launcher's failure chain surfaces it via the journal.
    if (tx.state === 'conflict') {
      throw new ProfileReconcileError(
        'apply',
        new Error('reconcile transaction ended in conflict; the journal records the divergence'),
      )
    }
    transactionId = tx.id
  }
  const manifestPath = path.join(ref.dir, 'package.json')
  const currentRaw = await readFile(manifestPath, 'utf8')
  return Object.freeze({
    ref,
    changed: plan.writes.length > 0,
    changedFiles: Object.freeze(plan.writes.map((write) => path.join(ref.dir, write.path))),
    // No manifest write planned means the file was already correct, so the
    // current bytes ARE the before-revision; reporting undefined there would
    // make "unchanged" indistinguishable from "unknown". A planned write
    // keeps its own before-revision (undefined when the file is new).
    beforeRevision:
      manifestWrite === undefined ? sha256(currentRaw) : (manifestWrite.before.sha256 ?? undefined),
    afterRevision: sha256(currentRaw),
    ...(transactionId === undefined ? {} : { transactionId }),
  })
}
