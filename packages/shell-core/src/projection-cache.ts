import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { syncDirectory, writeAtomicDurable } from '@deskwork/durable-fs'
import type { HomeSession } from '@deskwork/desktop-contracts/home-session'

export type CacheQuarantineResult =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'unknown-layout' }>
  | Readonly<{ kind: 'quarantined'; relativeBackupPath: string; bytes: number }>

const CACHE_RELATIVE = 'storages/session_projcache/sessions'
const CACHE_ROOT_RELATIVE = 'storages/session_projcache'
const QUARANTINE_PREFIX = 'session_projcache.quarantine-'
const QUARANTINE_RELATIVE_PREFIX = 'storages/'
const JOURNAL_RELATIVE = 'run/projection-cache-quarantine.json'

type QuarantineJournal = Readonly<{
  schemaVersion: 1
  id: string
  sourceRelative: string
  backupRelative: string
  bytes: number
  createdAt: string
  phase: 'intent' | 'renamed' | 'done'
}>

async function writeJournalDurable(home: string, journal: QuarantineJournal): Promise<void> {
  const file = path.join(home, JOURNAL_RELATIVE)
  // The quarantine runs before anything else may have created run/, so it
  // creates the directory itself rather than depending on a sibling.
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeAtomicDurable(file, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'))
}

type JournalRead =
  { state: 'present'; journal: QuarantineJournal } | { state: 'absent' } | { state: 'foreign' }

async function readJournal(home: string): Promise<JournalRead> {
  let raw: string
  try {
    raw = await readFile(path.join(home, JOURNAL_RELATIVE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { state: 'foreign' }
  }
  if (typeof value !== 'object' || value === null) return { state: 'foreign' }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return { state: 'foreign' }
  // The journal is untrusted input, field by field: a parsable but
  // structurally broken v1 record is unknown data, not a stale journal.
  if (
    typeof record.backupRelative !== 'string' ||
    typeof record.sourceRelative !== 'string' ||
    record.sourceRelative !== CACHE_RELATIVE ||
    // Only the exact backup naming this module writes is ever resolved
    // against the home.
    !record.backupRelative.startsWith(`${QUARANTINE_RELATIVE_PREFIX}${QUARANTINE_PREFIX}`) ||
    record.backupRelative.includes('..') ||
    typeof record.id !== 'string' ||
    record.id === '' ||
    typeof record.bytes !== 'number' ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.createdAt !== 'string' ||
    record.createdAt === '' ||
    (record.phase !== 'intent' && record.phase !== 'renamed' && record.phase !== 'done')
  ) {
    return { state: 'foreign' }
  }
  return { state: 'present', journal: record as unknown as QuarantineJournal }
}

/**
 * Total file size under the cache tree, or undefined when the tree cannot be
 * fully enumerated: an unreadable subtree means the layout is unknowable —
 * the caller must refuse to move anything rather than assume it is small.
 */
async function directorySize(root: string): Promise<number | undefined> {
  const { readdir } = await import('node:fs/promises')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    return undefined
  }
  let total = 0
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      return undefined
    }
    if (entry.isDirectory()) {
      const nested = await directorySize(target)
      if (nested === undefined) return undefined
      total += nested
    } else if (entry.isFile()) {
      const identity = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (identity === undefined) continue
      total += identity.size
    }
  }
  return total
}

/**
 * Quarantine an oversized, rebuildable projection cache while holding the
 * home session and with no running Host. Only the fixed baseline layout is
 * ever moved; anything unexpected reports unknown-layout without touching
 * disk. The move is a same-filesystem rename with an intent journal so a
 * crash at either boundary is recognizable, and the backup is kept.
 */
export async function quarantineProjectionCache(
  input: Readonly<{
    home: string
    session: HomeSession
    thresholdBytes: number
  }>,
): Promise<CacheQuarantineResult> {
  if (input.session.home !== input.home) {
    throw new Error('projection-cache quarantine requires a session bound to this home')
  }

  // Resolve the previous run's journal first: a crash after rename but before
  // the done marker must never move the backup a second time. A journal this
  // module cannot recognize — corrupt bytes or a foreign schema — is unknown
  // data: nothing is moved and, crucially, the journal itself is neither
  // rewritten nor deleted.
  const previous = await readJournal(input.home)
  if (previous.state === 'foreign') {
    return { kind: 'unknown-layout' }
  }
  if (previous.state === 'present') {
    const journal = previous.journal
    if (journal.phase !== 'done') {
      const backupDir = path.join(input.home, journal.backupRelative)
      const backupExists = await stat(backupDir).then(
        () => true,
        () => false,
      )
      if (backupExists) {
        // The rename either landed or never happened; the backup is intact
        // either way. The journal has served its purpose.
        await writeJournalDurable(input.home, { ...journal, phase: 'done' })
        await cleanupQuarantineJournal(input.home)
        return {
          kind: 'quarantined',
          relativeBackupPath: journal.backupRelative,
          bytes: journal.bytes,
        }
      }
      // No backup: treat as a stale journal and continue with a fresh scan.
    } else {
      await cleanupQuarantineJournal(input.home)
    }
  }

  const sourceRelative = CACHE_RELATIVE
  const sourceDir = path.join(input.home, sourceRelative)
  const storagesDir = path.join(input.home, CACHE_ROOT_RELATIVE)
  const storagesRoot = path.join(input.home, 'storages')
  // Every path component of the fixed layout must be a real directory: a
  // symlinked `storages/` or `session_projcache/` must never be moved.
  const parentIdentities: { path: string; dev: number; ino: number }[] = []
  for (const component of [storagesRoot, storagesDir]) {
    const identity = await lstat(component).catch(() => undefined)
    if (identity === undefined) return { kind: 'unchanged' }
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      return { kind: 'unknown-layout' }
    }
    parentIdentities.push({ path: component, dev: identity.dev, ino: identity.ino })
  }
  const sourceIdentity = await lstat(sourceDir).catch(() => undefined)
  if (sourceIdentity === undefined) return { kind: 'unchanged' }
  if (sourceIdentity.isSymbolicLink() || !sourceIdentity.isDirectory()) {
    return { kind: 'unknown-layout' }
  }
  // The fixed layout is exactly one `sessions` directory under the storage
  // root; extra siblings mean a layout we did not certify.
  const { readdir } = await import('node:fs/promises')
  const siblings = await readdir(storagesDir).catch(() => undefined)
  if (siblings === undefined || siblings.some((name) => name !== 'sessions')) {
    return { kind: 'unknown-layout' }
  }
  const bytes = await directorySize(sourceDir)
  if (bytes === undefined) return { kind: 'unknown-layout' }
  if (bytes < input.thresholdBytes) return { kind: 'unchanged' }
  // The size scan walked the tree; refuse to move anything if the directory
  // identity moved underneath us between the scan and the rename.
  const rescanned = await lstat(sourceDir).catch(() => undefined)
  if (
    rescanned === undefined ||
    rescanned.dev !== sourceIdentity.dev ||
    rescanned.ino !== sourceIdentity.ino
  ) {
    return { kind: 'unknown-layout' }
  }
  for (const expected of parentIdentities) {
    const current = await lstat(expected.path).catch(() => undefined)
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      return { kind: 'unknown-layout' }
    }
  }

  const id = randomUUID()
  const backupRelativePath = path.join(input.home, 'storages', `${QUARANTINE_PREFIX}${id}`)
  const backupRelativeForJournal = `storages/${QUARANTINE_PREFIX}${id}`

  await writeJournalDurable(input.home, {
    schemaVersion: 1,
    id,
    sourceRelative,
    backupRelative: backupRelativeForJournal,
    bytes,
    createdAt: new Date().toISOString(),
    phase: 'intent',
  })
  // Same-filesystem rename only; never copy-then-delete.
  await rename(sourceDir, backupRelativePath)
  await writeJournalDurable(input.home, {
    schemaVersion: 1,
    id,
    sourceRelative,
    backupRelative: backupRelativeForJournal,
    bytes,
    createdAt: new Date().toISOString(),
    phase: 'renamed',
  })
  await writeJournalDurable(input.home, {
    schemaVersion: 1,
    id,
    sourceRelative,
    backupRelative: backupRelativeForJournal,
    bytes,
    createdAt: new Date().toISOString(),
    phase: 'done',
  })
  await syncDirectory(path.dirname(backupRelativePath))
  // The journal only spans the crash window around the rename; once the move
  // is durably done it has no diagnostic value the backup itself lacks.
  await cleanupQuarantineJournal(input.home)
  return {
    kind: 'quarantined',
    relativeBackupPath: backupRelativeForJournal,
    bytes,
  }
}

export async function cleanupQuarantineJournal(home: string): Promise<void> {
  await rm(path.join(home, JOURNAL_RELATIVE), { force: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
}
