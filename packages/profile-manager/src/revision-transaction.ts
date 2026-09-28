import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rm, stat, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'

import type { HomeLease } from '@deskwork/home-lease'

import type { ProfileRef } from './profile-ref.js'
import { sha256Of } from './reconcile-plan.js'
import { MANAGED_PROFILE_PATHS } from './reconcile-plan.js'
import type { FileRevision, ManagedProfilePath, ProfileReconcilePlan } from './reconcile-plan.js'
import { assertRealDirectory, syncDirectory, writeAtomicDurable } from './durable-fs.js'

export type RevisionTransactionState =
  | 'prepared'
  | 'applying'
  | 'applied'
  | 'committed'
  | 'retained'
  | 'rolling-back'
  | 'rolled-back'
  | 'conflict'

export type RevisionTransaction = Readonly<{
  id: string
  ref: ProfileRef
  state: RevisionTransactionState
}>

type JournalWrite = Readonly<{
  path: ManagedProfilePath
  before: FileRevision
  candidateSha256: string
  applied: boolean
}>

type JournalRecord = Readonly<{
  schemaVersion: 1
  id: string
  ref: { home: string; name: string; dir: string }
  state: RevisionTransactionState
  createdAt: string
  writes: readonly JournalWrite[]
  failure?: { category: string; code: string } | undefined
}>

export const RETAINED_TRANSACTION_LIMIT = 20

function transactionsRoot(home: string): string {
  return path.join(home, 'run', 'profile-transactions')
}

function transactionDir(home: string, id: string): string {
  return path.join(transactionsRoot(home), id)
}

function journalPath(home: string, id: string): string {
  return path.join(transactionDir(home, id), 'transaction.json')
}

async function writeJournalDurable(home: string, record: JournalRecord): Promise<void> {
  await writeAtomicDurable(
    journalPath(home, record.id),
    new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
  )
}

const JOURNAL_STATES: readonly RevisionTransactionState[] = [
  'prepared',
  'applying',
  'applied',
  'committed',
  'retained',
  'rolling-back',
  'rolled-back',
  'conflict',
]
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/iu

export async function readJournal(
  home: string,
  id: string,
): Promise<JournalRecord | 'corrupt' | 'missing'> {
  if (!TRANSACTION_ID.test(id)) return 'corrupt'
  const file = journalPath(home, id)
  try {
    const identity = await lstat(file)
    if (identity.isSymbolicLink() || !identity.isFile()) return 'corrupt'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'missing'
    // A readdir entry that is not a transaction directory (e.g. a stray
    // `.DS_Store` the Finder dropped in) is simply not a journal — skip it
    // instead of failing the whole scan. Anything else (EACCES, …) stays a
    // conservative corrupt so an unreadable real journal blocks recovery.
    if (code === 'ENOTDIR' || code === 'ENAMETOOLONG') return 'missing'
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return 'corrupt'
  }
  if (typeof value !== 'object' || value === null) return 'corrupt'
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return 'corrupt'
  if (typeof record.id !== 'string' || record.id !== id) return 'corrupt'
  if (
    typeof record.state !== 'string' ||
    !JOURNAL_STATES.includes(record.state as RevisionTransactionState)
  ) {
    // An unrecognized state (bit rot, foreign writer) must never fall into
    // the recovery branches that treat unknown states as never-booted.
    return 'corrupt'
  }
  if (typeof record.createdAt !== 'string') return 'corrupt'
  // The ref comes from disk; a journal whose recorded profile escapes this
  // home's profiles/<name> layout is corrupt, never a rollback target.
  const ref = record.ref
  if (typeof ref !== 'object' || ref === null) return 'corrupt'
  const refRecord = ref as Record<string, unknown>
  if (
    typeof refRecord.home !== 'string' ||
    refRecord.home !== home ||
    typeof refRecord.name !== 'string' ||
    refRecord.name === '' ||
    refRecord.name === '.' ||
    refRecord.name === '..' ||
    refRecord.name.includes('/') ||
    refRecord.name.includes('\\') ||
    typeof refRecord.dir !== 'string' ||
    refRecord.dir !== path.join(home, 'profiles', refRecord.name)
  ) {
    return 'corrupt'
  }
  if (!Array.isArray(record.writes)) return 'corrupt'
  const writePaths = new Set<string>()
  for (const write of record.writes) {
    if (typeof write !== 'object' || write === null) return 'corrupt'
    const entry = write as Record<string, unknown>
    const before = entry.before as Record<string, unknown>
    if (
      typeof entry.path !== 'string' ||
      !['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'].includes(entry.path) ||
      typeof entry.candidateSha256 !== 'string' ||
      !SHA256.test(entry.candidateSha256) ||
      typeof entry.applied !== 'boolean' ||
      typeof entry.before !== 'object' ||
      entry.before === null ||
      typeof before.exists !== 'boolean' ||
      (before.exists && (typeof before.sha256 !== 'string' || !SHA256.test(before.sha256))) ||
      (!before.exists && before.sha256 !== null)
    ) {
      return 'corrupt'
    }
    if (writePaths.has(entry.path)) return 'corrupt'
    writePaths.add(entry.path)
  }
  return record as unknown as JournalRecord
}

async function beforeSnapshotPath(
  home: string,
  id: string,
  relative: ManagedProfilePath,
): Promise<string> {
  return path.join(transactionDir(home, id), 'before', relative)
}

async function writeBeforeSnapshot(
  home: string,
  id: string,
  relative: ManagedProfilePath,
  bytes: Uint8Array,
): Promise<void> {
  const target = await beforeSnapshotPath(home, id, relative)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const handle = await open(target, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(path.dirname(target))
}

async function writeCandidate(filename: string, bytes: Uint8Array): Promise<void> {
  await writeAtomicDurable(filename, bytes)
}

async function currentSha(filename: string): Promise<{
  kind: 'missing' | 'file' | 'other'
  sha: string | null
  inode: { dev: number; ino: number } | null
}> {
  try {
    const identity = await lstat(filename)
    if (!identity.isFile()) return { kind: 'other', sha: null, inode: null }
    return {
      kind: 'file',
      sha: sha256Of(new Uint8Array(await readFile(filename))),
      inode: { dev: identity.dev, ino: identity.ino },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing', sha: null, inode: null }
    }
    throw error
  }
}

export { currentSha }

function assertLeaseMatches(lease: HomeLease, ref: ProfileRef): void {
  if (lease.home !== ref.home) {
    throw new Error('profile transaction requires a lease bound to the transaction home')
  }
}

/**
 * Persist the journal (prepared) with before snapshots, then apply each
 * planned write and record per-file progress. Every side effect is preceded
 * by a durable intent so a crash at any boundary is recoverable from disk
 * facts alone.
 */
export async function applyProfileTransaction(
  plan: ProfileReconcilePlan,
  lease: HomeLease,
): Promise<RevisionTransaction> {
  assertLeaseMatches(lease, plan.ref)
  if (plan.ref.dir !== path.join(plan.ref.home, 'profiles', plan.ref.name)) {
    throw new Error('ProfileRef directory does not match its home')
  }
  // The managed-path whitelist is a runtime invariant, not just a type: no
  // plan — however constructed — may journal or touch anything outside the
  // three files the revision model owns.
  if (plan.writes.some((write) => !MANAGED_PROFILE_PATHS.includes(write.path))) {
    throw new Error('profile transaction plans may only reference whitelisted paths')
  }
  const home = plan.ref.home
  const id = randomUUID()
  // The lease must be proven live BEFORE any transaction state lands on
  // disk: a stale lease would otherwise leave a half-born transaction for
  // the recovery scan to trip over before the failure surfaces here.
  await lease.assertHeld()
  // The transaction tree must sit inside the real home layout: a symlinked
  // run/ or profile-transactions/ root would move journals (and before
  // snapshots) outside the home.
  await assertRealDirectory(path.join(home, 'run'), 'DSH home run directory')
  const rootExisted = await assertRealDirectory(transactionsRoot(home), 'profile transactions root')
  if (!rootExisted) await mkdir(transactionsRoot(home), { recursive: true, mode: 0o700 })
  await assertRealDirectory(transactionsRoot(home), 'profile transactions root')
  await mkdir(transactionDir(home, id), { recursive: true, mode: 0o700 })
  await mkdir(path.join(transactionDir(home, id), 'before'), { recursive: true, mode: 0o700 })

  let record: JournalRecord = {
    schemaVersion: 1,
    id,
    ref: { home: plan.ref.home, name: plan.ref.name, dir: plan.ref.dir },
    state: 'prepared',
    createdAt: new Date().toISOString(),
    writes: plan.writes.map((write) => ({
      path: write.path,
      before: write.before,
      candidateSha256: write.candidateSha256,
      applied: false,
    })),
  }
  await writeJournalDurable(home, record)

  for (const write of plan.writes) {
    if (write.beforeBytes !== null) {
      await writeBeforeSnapshot(home, id, write.path, write.beforeBytes)
    }
  }

  record = { ...record, state: 'applying' }
  await writeJournalDurable(home, record)

  await ensureRealProfileDirectory(plan.ref)
  for (const write of plan.writes) {
    await ensureRealProfileDirectory(plan.ref)
    const filename = path.join(plan.ref.dir, write.path)
    const { sha } = await currentSha(filename)
    if (sha === write.candidateSha256) {
      // A previous interrupted application already landed this exact content.
      record = {
        ...record,
        writes: record.writes.map((entry) =>
          entry.path === write.path ? { ...entry, applied: true } : entry,
        ),
      }
      await writeJournalDurable(home, record)
      continue
    }
    if (sha !== (write.before.sha256 ?? null)) {
      record = { ...record, state: 'conflict' }
      await writeJournalDurable(home, record)
      return { id, ref: plan.ref, state: 'conflict' }
    }
    await writeCandidate(filename, write.candidateBytes)
    record = {
      ...record,
      writes: record.writes.map((entry) =>
        entry.path === write.path ? { ...entry, applied: true } : entry,
      ),
    }
    await writeJournalDurable(home, record)
    await lease.assertHeld()
  }

  record = { ...record, state: 'applied' }
  await writeJournalDurable(home, record)
  return { id, ref: plan.ref, state: 'applied' }
}

async function mkdirProfileDirectory(ref: ProfileRef): Promise<void> {
  await mkdir(ref.dir, { recursive: true, mode: 0o700 })
}

async function ensureRealProfileDirectory(ref: ProfileRef): Promise<void> {
  const profiles = path.join(ref.home, 'profiles')
  const profilesExisted = await assertRealDirectory(profiles, 'DSH profiles directory')
  if (!profilesExisted) await mkdir(profiles, { recursive: true, mode: 0o700 })
  await assertRealDirectory(profiles, 'DSH profiles directory')
  const profileExisted = await assertRealDirectory(ref.dir, 'profile directory')
  if (!profileExisted) await mkdirProfileDirectory(ref)
  await assertRealDirectory(ref.dir, 'profile directory')
}

export async function commitProfileTransaction(id: string, lease: HomeLease): Promise<void> {
  const journal = await readJournal(lease.home, id)
  if (journal === 'missing' || journal === 'corrupt') {
    throw new Error(`cannot commit transaction ${id}: journal ${journal}`)
  }
  await lease.assertHeld()
  if (journal.state !== 'applied') {
    throw new Error(`cannot commit transaction ${id} from state ${journal.state}`)
  }
  await writeJournalDurable(lease.home, {
    ...journal,
    state: 'committed',
  })
  await pruneRetainedTransactions(lease.home)
}

/** Record an explicit decision not to roll back (with the failure category). */
export async function retainProfileTransaction(
  id: string,
  lease: HomeLease,
  failure: Readonly<{ category: string; code: string }>,
): Promise<void> {
  const journal = await readJournal(lease.home, id)
  if (journal === 'missing' || journal === 'corrupt') {
    throw new Error(`cannot retain transaction ${id}: journal ${journal}`)
  }
  await lease.assertHeld()
  if (journal.state !== 'applied') {
    // A conflict or already-settled journal must never be rewritten by a
    // later retain decision — its recorded outcome is the diagnosis.
    throw new Error(`cannot retain transaction ${id} from state ${journal.state}`)
  }
  await writeJournalDurable(lease.home, {
    ...journal,
    state: 'retained',
    failure,
  })
  await pruneRetainedTransactions(lease.home)
}

export async function rollbackProfileTransaction(
  id: string,
  lease: HomeLease,
): Promise<'restored' | 'conflict'> {
  const journal = await readJournal(lease.home, id)
  if (journal === 'missing' || journal === 'corrupt') {
    throw new Error(`cannot roll back transaction ${id}: journal ${journal}`)
  }
  await lease.assertHeld()
  if (journal.state === 'rolled-back') return 'restored'
  if (
    journal.state === 'committed' ||
    journal.state === 'retained' ||
    journal.state === 'conflict'
  ) {
    return 'conflict'
  }

  const ref = journal.ref as ProfileRef
  // Phase 1: verify every affected file is exactly at before or candidate,
  // recording the inode each verification saw.
  const checked: {
    write: JournalWrite
    sha: string | null
    inode: { dev: number; ino: number } | null
  }[] = []
  for (const write of journal.writes) {
    const filename = path.join(ref.dir, write.path)
    const current = await currentSha(filename)
    const allowed: (string | null)[] = [write.candidateSha256, write.before.sha256]
    if (write.before.exists === false && current.kind === 'missing') allowed.push(null)
    if (current.kind === 'other' || !allowed.includes(current.sha)) {
      await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
      return 'conflict'
    }
    checked.push({ write, sha: current.sha, inode: current.inode })
  }

  await writeJournalDurable(lease.home, { ...journal, state: 'rolling-back' })

  // Phase 2: idempotently move each file back to before, re-verifying the
  // path/inode/digest immediately before every write so drift between the
  // two phases is never clobbered.
  for (const { write, inode } of checked) {
    const filename = path.join(ref.dir, write.path)
    const current = await currentSha(filename)
    if (!sameInode(current.inode, inode)) {
      await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
      return 'conflict'
    }
    const sha = current.sha
    if (write.before.exists === false) {
      if (current.kind === 'missing') continue
      if (current.kind !== 'file') {
        await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
        return 'conflict'
      }
      if (sha === write.candidateSha256) {
        await unlink(filename)
        await syncDirectory(path.dirname(filename))
        continue
      }
      // In-place drift between the phases on a file this transaction created:
      // the same divergence the before-exists branch treats as conflict.
      await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
      return 'conflict'
    }
    if (sha === write.before.sha256) continue
    if (sha === write.candidateSha256) {
      const snapshot = await beforeSnapshotPath(lease.home, id, write.path)
      let snapshotIdentity: Stats
      try {
        snapshotIdentity = await stat(snapshot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // A missing before-snapshot for a file needing restore is a broken
        // journal, not a reason to leave candidate bytes in place.
        await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
        return 'conflict'
      }
      if (snapshotIdentity.isFile() !== true) {
        await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
        return 'conflict'
      }
      const bytes = new Uint8Array(await readFile(snapshot))
      if (sha256Of(bytes) !== write.before.sha256) {
        await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
        return 'conflict'
      }
      await writeCandidate(filename, bytes)
      continue
    }
    await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
    return 'conflict'
  }

  await writeJournalDurable(lease.home, { ...journal, state: 'rolled-back' })
  await pruneRetainedTransactions(lease.home)
  return 'restored'
}

function sameInode(
  left: { dev: number; ino: number } | null,
  right: { dev: number; ino: number } | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Every path segment from the home down must be a real directory before a
 * recursive delete: a symlinked `run`, `profile-transactions`, or `<id>`
 * would redirect the prune outside the home. lstat only refuses to follow
 * its final segment, so each accumulated prefix is checked on its own.
 */
async function isRealDirectoryChain(home: string, ...segments: string[]): Promise<boolean> {
  const { lstat } = await import('node:fs/promises')
  let current = home
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false
    } catch {
      return false
    }
  }
  return true
}

/** Drop terminal transaction directories beyond the retention window. */
export async function pruneRetainedTransactions(home: string): Promise<void> {
  const root = transactionsRoot(home)
  // A redirected root (symlinked `run/` or `profile-transactions/`) means
  // every enumerated id would delete outside the home — prune nothing.
  if (!(await isRealDirectoryChain(home, 'run', 'profile-transactions'))) return
  const entries = await readdirSafe(root)
  const records: { id: string; createdAt: string }[] = []
  for (const id of entries) {
    const journal = await readJournal(home, id)
    if (journal === 'missing' || journal === 'corrupt') continue
    if (
      journal.state === 'committed' ||
      journal.state === 'rolled-back' ||
      journal.state === 'retained'
    ) {
      records.push({ id: journal.id, createdAt: journal.createdAt })
    }
  }
  if (records.length <= RETAINED_TRANSACTION_LIMIT) return
  records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const excess = records.slice(0, records.length - RETAINED_TRANSACTION_LIMIT)
  for (const record of excess) {
    // Re-check immediately before the delete: only a real directory under
    // the real root is ever removed; a symlinked id stays untouched.
    if (await isRealDirectoryChain(home, 'run', 'profile-transactions', record.id)) {
      await rm(transactionDir(home, record.id), { recursive: true, force: true })
    }
  }
  await syncDirectory(root)
}

async function readdirSafe(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    return await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export { transactionsRoot, transactionDir, journalPath }

/** Directory ids of all recorded transactions, oldest-first irrelevant. */
export async function readdirTransactionIds(home: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    return await readdir(transactionsRoot(home))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export type { JournalRecord, JournalWrite }
