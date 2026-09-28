import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createInProcessGuardLock,
  type HomeLease,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'

import { quarantineProjectionCache } from '../src/projection-cache.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const fixtures: IsolatedHomeFixture[] = []

async function home(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

function sameProbe(): ProcessProbe {
  return {
    async current() {
      return { pid: process.pid, startIdentity: 'cache-probe' }
    },
    async identify(pid) {
      return { pid, startIdentity: 'cache-probe' }
    },
    async inspect() {
      return 'same' as const
    },
    async scanSupported() {
      return 'none' as const
    },
  }
}

async function leaseOf(dir: string): Promise<HomeLease> {
  return acquireHomeLease({
    home: dir,
    entrypoint: 'desktop',
    profile: 'deskwork',
    appVersion: '0.0.0',
    probe: sameProbe(),
    guard: createInProcessGuardLock(),
  })
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

async function cacheDir(dir: string): Promise<string> {
  return path.join(dir, 'storages', 'session_projcache', 'sessions')
}

async function writeCache(dir: string, sizeBytes: number): Promise<string> {
  const target = await cacheDir(dir)
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'proj-1.bin'), Buffer.alloc(sizeBytes, 1))
  return target
}

describe('quarantineProjectionCache', () => {
  it('leaves a small cache untouched', async () => {
    const dir = await home()
    await writeCache(dir, 100)
    const lease = await leaseOf(dir)
    const result = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    expect(result).toEqual({ kind: 'unchanged' })
    expect(await stat(await cacheDir(dir))).toBeTruthy()
    await lease.release()
  })

  it('moves an oversized cache to a kept backup with original bytes', async () => {
    const dir = await home()
    const sessionLog = path.join(dir, 'sessions', 'session.jsonl')
    await mkdir(path.dirname(sessionLog), { recursive: true })
    await writeFile(sessionLog, 'session-data\n')
    await writeCache(dir, 2048)
    const lease = await leaseOf(dir)
    const result = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    expect(result.kind).toBe('quarantined')
    if (result.kind !== 'quarantined') throw new Error('unreachable')
    expect(result.bytes).toBeGreaterThanOrEqual(2048)
    const backup = path.join(dir, result.relativeBackupPath)
    expect(await readFile(path.join(backup, 'proj-1.bin'))).toEqual(Buffer.alloc(2048, 1))
    await expect(stat(await cacheDir(dir))).rejects.toMatchObject({ code: 'ENOENT' })
    // Session JSONL and other storages are untouched.
    expect(await readFile(sessionLog, 'utf8')).toBe('session-data\n')
    await lease.release()
  })

  it('refuses without a matching lease', async () => {
    const dir = await home()
    await writeCache(dir, 2048)
    const other = await home()
    const lease = await leaseOf(other)
    await expect(
      quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 }),
    ).rejects.toThrow(/lease/u)
    expect(await stat(await cacheDir(dir))).toBeTruthy()
    await lease.release()
  })

  it('refuses symlinked or unrecognized layouts without moving anything', async () => {
    const dir = await home()
    const external = await home()
    await mkdir(path.join(external, 'real-sessions'), { recursive: true })
    const projRoot = path.join(dir, 'storages', 'session_projcache')
    await mkdir(projRoot, { recursive: true })
    await symlink(path.join(external, 'real-sessions'), path.join(projRoot, 'sessions'), 'dir')
    const lease = await leaseOf(dir)
    // A symlinked sessions entry is an uncertified layout: refuse, never move.
    expect(await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1 })).toEqual({
      kind: 'unknown-layout',
    })
    await lease.release()

    // A symlinked parent of the fixed layout is equally uncertified.
    const dirParent = await home()
    const externalParent = await home()
    await mkdir(path.join(externalParent, 'session_projcache', 'sessions'), { recursive: true })
    await mkdir(path.join(dirParent, 'storages'), { recursive: true })
    await symlink(
      path.join(externalParent, 'session_projcache'),
      path.join(dirParent, 'storages', 'session_projcache'),
      'dir',
    )
    const parentLease = await leaseOf(dirParent)
    expect(
      await quarantineProjectionCache({ home: dirParent, lease: parentLease, thresholdBytes: 1 }),
    ).toEqual({ kind: 'unknown-layout' })
    await parentLease.release()

    // Extra sibling under the storage root means an uncertified layout.
    const dir2 = await home()
    await writeCache(dir2, 2048)
    await mkdir(path.join(dir2, 'storages', 'session_projcache', 'unexpected'), {
      recursive: true,
    })
    const lease2 = await leaseOf(dir2)
    expect(
      await quarantineProjectionCache({ home: dir2, lease: lease2, thresholdBytes: 1024 }),
    ).toEqual({ kind: 'unknown-layout' })
    expect(await stat(await cacheDir(dir2))).toBeTruthy()
    await lease2.release()
  })

  it('reports unknown-layout when the cache tree cannot be enumerated', async () => {
    const dir = await home()
    const cache = await writeCache(dir, 2048)
    // An unreadable subtree makes the size — and with it the layout —
    // unknowable: refuse to move anything instead of assuming "small".
    const locked = path.join(cache, 'locked-session')
    await mkdir(locked, { recursive: true, mode: 0o700 })
    await writeFile(path.join(locked, 'proj.bin'), 'x'.repeat(64))
    await chmod(locked, 0o000)
    const lease = await leaseOf(dir)
    try {
      expect(await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1 })).toEqual({
        kind: 'unknown-layout',
      })
      expect(await stat(cache)).toBeTruthy()
    } finally {
      await chmod(locked, 0o700)
      await lease.release()
    }
  })

  it('refuses a symlink nested in the cache tree', async () => {
    const dir = await home()
    const cache = await writeCache(dir, 2048)
    const external = await home()
    await writeFile(path.join(external, 'outside.bin'), Buffer.alloc(2048, 2))
    await symlink(path.join(external, 'outside.bin'), path.join(cache, 'linked.bin'), 'file')
    const lease = await leaseOf(dir)
    expect(await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1 })).toEqual({
      kind: 'unknown-layout',
    })
    expect(await stat(cache)).toBeTruthy()
    await lease.release()
  })

  it('recognizes an interrupted rename from the journal and never moves the backup', async () => {
    const dir = await home()
    await writeCache(dir, 2048)
    const lease = await leaseOf(dir)
    const first = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    if (first.kind !== 'quarantined') throw new Error('first quarantine failed')
    // A successful quarantine cleans its journal up; rebuild the crash window
    // by hand: a journal stuck at 'renamed' with the backup already moved.
    const journalFile = path.join(dir, 'run', 'projection-cache-quarantine.json')
    await writeFile(
      journalFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'interrupted-quarantine',
          sourceRelative: 'storages/session_projcache/sessions',
          backupRelative: first.relativeBackupPath,
          bytes: first.bytes,
          createdAt: new Date().toISOString(),
          phase: 'renamed',
        },
        null,
        2,
      )}\n`,
    )
    const second = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    expect(second).toEqual({
      kind: 'quarantined',
      relativeBackupPath: first.relativeBackupPath,
      bytes: first.bytes,
    })
    // The backup was not moved a second time and the settled journal is gone.
    expect(await stat(path.join(dir, first.relativeBackupPath))).toBeTruthy()
    await expect(readFile(journalFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await lease.release()
  })

  it('refuses to touch anything when the quarantine journal is corrupt', async () => {
    const dir = await home()
    await writeCache(dir, 2048)
    const lease = await leaseOf(dir)
    const journalFile = path.join(dir, 'run', 'projection-cache-quarantine.json')
    await mkdir(path.dirname(journalFile), { recursive: true, mode: 0o700 })
    await writeFile(journalFile, '{corrupt', { mode: 0o600 })
    // Unknown journal data is never overwritten: report unknown-layout with
    // the cache and the journal byte-identical to before.
    expect(await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1 })).toEqual({
      kind: 'unknown-layout',
    })
    expect(await readFile(journalFile, 'utf8')).toBe('{corrupt')
    expect(await stat(await cacheDir(dir))).toBeTruthy()
    await lease.release()
  })

  it('treats a structurally invalid v1 journal as unknown data', async () => {
    const dir = await home()
    await writeCache(dir, 2048)
    const lease = await leaseOf(dir)
    const journalFile = path.join(dir, 'run', 'projection-cache-quarantine.json')
    await mkdir(path.dirname(journalFile), { recursive: true, mode: 0o700 })
    // Parsable JSON with schemaVersion 1, but a phase this module never
    // writes and bytes of the wrong type: not a stale journal, unknown data.
    const broken = `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'not-mine',
        sourceRelative: 'storages/session_projcache/sessions',
        backupRelative: 'storages/session_projcache.quarantine-not-mine',
        bytes: 'lots',
        createdAt: new Date().toISOString(),
        phase: 42,
      },
      null,
      2,
    )}\n`
    await writeFile(journalFile, broken, { mode: 0o600 })
    expect(await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1 })).toEqual({
      kind: 'unknown-layout',
    })
    expect(await readFile(journalFile, 'utf8')).toBe(broken)
    expect(await stat(await cacheDir(dir))).toBeTruthy()
    await lease.release()
  })

  it('treats a journal without its backup as stale and rescans', async () => {
    const dir = await home()
    await writeCache(dir, 2048)
    const lease = await leaseOf(dir)
    const journalFile = path.join(dir, 'run', 'projection-cache-quarantine.json')
    await mkdir(path.dirname(journalFile), { recursive: true, mode: 0o700 })
    await writeFile(
      journalFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'stale',
          sourceRelative: 'storages/session_projcache/sessions',
          backupRelative: 'storages/session_projcache.quarantine-stale',
          bytes: 2048,
          createdAt: new Date().toISOString(),
          phase: 'intent',
        },
        null,
        2,
      )}\n`,
    )
    const result = await quarantineProjectionCache({
      home: dir,
      lease,
      thresholdBytes: 1024,
    })
    // No backup ever landed: the journal is stale, the fresh scan quarantined
    // the cache under a new id.
    expect(result.kind).toBe('quarantined')
    await lease.release()
  })
})
