import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearHostOwner,
  hostLockPath,
  hostOwnerPath,
  readHostOwner,
  recordHostOwner,
  settleOrphanHost,
  tryAcquireHostLock,
} from '../src/host-owner.js'

const homes: string[] = []

async function testHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-owner-test-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

const argvPin = '/Applications/Deskwork.app/Contents/Resources/runtime-host/lib/host-entry.js'

describe('host owner record', () => {
  it('round-trips a record and reads a cleared record as absent', async () => {
    const home = await testHome()
    expect(await readHostOwner(home)).toBeUndefined()

    await recordHostOwner({
      home,
      identity: { pid: 4321, startIdentity: 'started-at-t' },
      argvPin,
      recordedAt: '2026-10-02T00:00:00.000Z',
    })
    const record = await readHostOwner(home)
    expect(record).toMatchObject({ pid: 4321, argvPin, home })

    await clearHostOwner(home)
    expect(await readHostOwner(home)).toBeUndefined()
  })

  it('keeps the record and the lock under the home run directory', async () => {
    const home = await testHome()
    await recordHostOwner({ home, identity: { pid: 1, startIdentity: 's' }, argvPin })
    expect(hostOwnerPath(home)).toBe(path.join(home, 'run', 'host-owner.json'))
    expect(hostLockPath(home)).toBe(path.join(home, 'run', 'host.lock'))
  })

  it('treats a corrupt record as absent instead of failing the boot', async () => {
    const home = await testHome()
    await recordHostOwner({ home, identity: { pid: 4321, startIdentity: 's' }, argvPin })
    await writeFile(hostOwnerPath(home), '{ not json')
    expect(await readHostOwner(home)).toBeUndefined()
    expect(await settleOrphanHost({ home })).toEqual({ outcome: 'none' })
  })
})

describe('host lock', () => {
  it('is exclusive across open file descriptions', async () => {
    const home = await testHome()
    const first = await tryAcquireHostLock(home)
    expect(first).toBeDefined()
    expect(await tryAcquireHostLock(home)).toBeUndefined()
    await first?.release()
    const second = await tryAcquireHostLock(home)
    expect(second).toBeDefined()
    await second?.release()
  })

  it('is released when the holder closes its descriptor', async () => {
    const home = await testHome()
    const lock = await tryAcquireHostLock(home)
    await lock?.release()
    const again = await tryAcquireHostLock(home)
    expect(again).toBeDefined()
    await again?.release()
  })
})

describe('settleOrphanHost', () => {
  it('reports nothing to settle when the home is free and unrecorded', async () => {
    const home = await testHome()
    expect(await settleOrphanHost({ home })).toEqual({ outcome: 'none' })
  })

  it('reclaims a stale record when no Host holds the lock', async () => {
    const home = await testHome()
    await recordHostOwner({ home, identity: { pid: 4321, startIdentity: 's' }, argvPin })
    expect(await settleOrphanHost({ home })).toEqual({ outcome: 'reclaimed', pid: 4321 })
    expect(await readHostOwner(home)).toBeUndefined()
  })

  it('does not signal a recorded pid when the lock is free, however alive it looks', async () => {
    // The lock, not the pid, decides: a recycled pid must never be signalled.
    const home = await testHome()
    await recordHostOwner({ home, identity: { pid: process.pid, startIdentity: 's' }, argvPin })
    const terminate = vi.fn()
    const resolution = await settleOrphanHost({ home, terminate })
    expect(resolution).toEqual({ outcome: 'reclaimed', pid: process.pid })
    expect(terminate).not.toHaveBeenCalled()
  })

  it('refuses to start while a Host holds the lock and no record names it', async () => {
    const home = await testHome()
    const held = await tryAcquireHostLock(home)
    const resolution = await settleOrphanHost({ home, waitMs: 50 })
    expect(resolution).toEqual({ outcome: 'still-running' })
    await held?.release()
  })

  it('waits for a locked Host that exits on its own', async () => {
    const home = await testHome()
    await recordHostOwner({ home, identity: { pid: 4321, startIdentity: 's' }, argvPin })
    const held = await tryAcquireHostLock(home)
    setTimeout(() => void held?.release(), 50)
    const terminate = vi.fn()
    const resolution = await settleOrphanHost({ home, terminate, waitMs: 2_000 })
    expect(resolution).toEqual({ outcome: 'terminated', pid: 4321 })
    expect(terminate).not.toHaveBeenCalled()
    expect(await readHostOwner(home)).toBeUndefined()
  })

  it('signals the recorded pid when a live Host keeps the lock', async () => {
    const home = await testHome()
    await recordHostOwner({ home, identity: { pid: 4321, startIdentity: 's' }, argvPin })
    const held = await tryAcquireHostLock(home)
    const signals: string[] = []
    const resolution = await settleOrphanHost({
      home,
      waitMs: 50,
      isAlive: () => true,
      terminate: (_pid, signal) => {
        signals.push(signal)
        void held?.release()
      },
    })
    expect(signals).toEqual(['SIGTERM'])
    expect(resolution).toEqual({ outcome: 'terminated', pid: 4321 })
    expect(await readHostOwner(home)).toBeUndefined()
  })

  it('refuses to start and keeps the record when the Host survives every signal', async () => {
    const home = await testHome()
    await recordHostOwner({ home, identity: { pid: 4321, startIdentity: 's' }, argvPin })
    const held = await tryAcquireHostLock(home)
    const signals: string[] = []
    const resolution = await settleOrphanHost({
      home,
      waitMs: 20,
      isAlive: () => true,
      terminate: (_pid, signal) => signals.push(signal),
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(resolution).toEqual({ outcome: 'still-running', pid: 4321 })
    // The record stays so the next attempt re-runs the same check instead of
    // silently starting a second writer.
    expect((await readHostOwner(home))?.pid).toBe(4321)
    await held?.release()
  })
})
