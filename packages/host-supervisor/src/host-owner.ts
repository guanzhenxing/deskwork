import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { writeAtomicDurable } from '@deskwork/durable-fs'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

import { isProcessAlive, type ProcessIdentity } from './process-probe.js'

/**
 * Whole-home single-writer ownership for a single-entry application.
 *
 * Two pieces with clearly separated jobs:
 *
 *  - `<home>/run/host.lock` — an exclusive POSIX `flock` held by the Host
 *    process itself. This is the *liveness authority*: the kernel drops it
 *    when the process dies for any reason, including SIGKILL, so it can never
 *    go stale and it cannot be confused by a recycled pid.
 *  - `<home>/run/host-owner.json` — the recorded pid and the Host entry it was
 *    started with. This is *reachability and diagnostics*: when the lock says
 *    a Host is alive, the record is what lets the next run stop it. A record
 *    without a held lock is stale by definition and is simply discarded.
 *
 * This is not a cross-process protocol; it exists so that a run which died
 * without stopping its Host cannot leave that Host writing while a fresh run
 * starts its own.
 */
export type HostOwnerRecord = Readonly<{
  schemaVersion: 1
  pid: number
  /** The Host entry path the recorded pid was started with. */
  argvPin: string
  home: string
  recordedAt: string
}>

const recordFile = 'host-owner.json'
const lockFile = 'host.lock'

export function hostOwnerPath(home: string): string {
  return path.join(home, 'run', recordFile)
}

export function hostLockPath(home: string): string {
  return path.join(home, 'run', lockFile)
}

async function ensureRunDirectory(home: string): Promise<void> {
  await mkdir(path.join(home, 'run'), { recursive: true, mode: 0o700 })
}

export async function readHostOwner(home: string): Promise<HostOwnerRecord | undefined> {
  const raw = await readFile(hostOwnerPath(home), 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  return parseHostOwner(raw)
}

/** Closed-schema parse: anything unexpected reads as "no usable record". */
export function parseHostOwner(raw: string): HostOwnerRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return undefined
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined
  if (typeof record.argvPin !== 'string' || record.argvPin === '') return undefined
  if (typeof record.home !== 'string' || record.home === '') return undefined
  if (typeof record.recordedAt !== 'string' || record.recordedAt === '') return undefined
  return Object.freeze({
    schemaVersion: 1,
    pid: record.pid as number,
    argvPin: record.argvPin,
    home: record.home,
    recordedAt: record.recordedAt,
  })
}

export type RecordHostOwnerInput = Readonly<{
  home: string
  identity: ProcessIdentity
  argvPin: string
  recordedAt?: string
}>

export async function recordHostOwner(input: RecordHostOwnerInput): Promise<HostOwnerRecord> {
  const record: HostOwnerRecord = Object.freeze({
    schemaVersion: 1,
    pid: input.identity.pid,
    argvPin: input.argvPin,
    home: input.home,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  })
  await ensureRunDirectory(input.home)
  await writeAtomicDurable(
    hostOwnerPath(input.home),
    Buffer.from(`${JSON.stringify(record, undefined, 2)}\n`, 'utf8'),
  )
  return record
}

export async function clearHostOwner(home: string): Promise<void> {
  await ensureRunDirectory(home)
  await writeFile(hostOwnerPath(home), `${JSON.stringify({ schemaVersion: 0 })}\n`, {
    mode: 0o600,
  }).catch(() => undefined)
}

export type HostLock = Readonly<{ release(): Promise<void> }>

/**
 * Take the home's Host lock without waiting.
 *
 * Returns a handle when this process now owns the home, or `undefined` when a
 * live process holds it. The descriptor is deliberately not closed until
 * {@link HostLock.release}: the kernel keeps the lock for as long as the open
 * file description exists.
 */
export async function tryAcquireHostLock(home: string): Promise<HostLock | undefined> {
  await ensureRunDirectory(home)
  const descriptor = await open(hostLockPath(home), 'w', 0o600)
  try {
    await tryLockExclusive(descriptor.fd)
  } catch (error) {
    await descriptor.close()
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return undefined
    throw error
  }
  let released: Promise<void> | undefined
  return Object.freeze({
    release(): Promise<void> {
      released ??= descriptor.close()
      return released
    },
  })
}

export type OrphanOutcome = 'none' | 'reclaimed' | 'terminated' | 'still-running'

export type OrphanResolution = Readonly<{ outcome: OrphanOutcome; pid?: number }>

export type SettleOrphanInput = Readonly<{
  home: string
  /** How long a live Host is given to finish on its own before it is signalled. */
  waitMs?: number
  isAlive?: (pid: number) => boolean
  terminate?: (pid: number, signal: NodeJS.Signals) => void
}>

/**
 * Decide what to do about a Host left behind by an earlier run.
 *
 * The lock answers the only question that matters — is a Host alive right
 * now? — and the record says which process to stop when the answer is yes.
 * Everything else (no record, a dead pid, a pid recycled by an unrelated
 * program) resolves to "take the home and carry on".
 */
export async function settleOrphanHost(input: SettleOrphanInput): Promise<OrphanResolution> {
  const waitMs = input.waitMs ?? 5_000
  const isAlive = input.isAlive ?? isProcessAlive
  const terminate = input.terminate ?? ((pid, signal) => process.kill(pid, signal))
  const record = await readHostOwner(input.home)

  const free = await tryAcquireHostLock(input.home)
  if (free !== undefined) {
    await free.release()
    if (record === undefined) return { outcome: 'none' }
    await clearHostOwner(input.home)
    return { outcome: 'reclaimed', pid: record.pid }
  }

  // A live Host holds the lock. Without a usable record there is nothing to
  // signal, so this run refuses rather than risk a second writer.
  if (record === undefined) return { outcome: 'still-running' }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!isAlive(record.pid)) return await waitForRelease(input.home, 2_000)
    await delay(100)
  }

  try {
    terminate(record.pid, 'SIGTERM')
  } catch {
    return await waitForRelease(input.home, 2_000)
  }
  const afterTerm = await waitForRelease(input.home, 5_000)
  if (afterTerm.outcome !== 'still-running') return afterTerm
  try {
    terminate(record.pid, 'SIGKILL')
  } catch {
    /* the process may have exited between the check and the signal */
  }
  return await waitForRelease(input.home, 2_000)
}

/** Wait for the lock to come free; report the recorded pid either way. */
async function waitForRelease(home: string, timeoutMs: number): Promise<OrphanResolution> {
  const record = await readHostOwner(home)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lock = await tryAcquireHostLock(home)
    if (lock !== undefined) {
      await lock.release()
      await clearHostOwner(home)
      return { outcome: 'terminated', ...(record === undefined ? {} : { pid: record.pid }) }
    }
    if (Date.now() > deadline) {
      // The record stays so the next attempt re-runs the same check instead of
      // silently starting a second writer.
      return { outcome: 'still-running', ...(record === undefined ? {} : { pid: record.pid }) }
    }
    await delay(100)
  }
}
