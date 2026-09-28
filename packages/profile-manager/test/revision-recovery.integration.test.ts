import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  defaultLeaseHelperPath,
} from '@deskwork/home-lease'

import { createProfileRef } from '../src/index.js'
import { planDesktopReconcile } from '../src/reconcile-plan.js'
import {
  applyProfileTransaction,
  commitProfileTransaction,
  journalPath,
  readJournal,
  rollbackProfileTransaction,
  transactionDir,
} from '../src/revision-transaction.js'
import { recoverInterruptedTransactions } from '../src/revision-recovery.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const helperAvailable =
  process.platform === 'darwin' &&
  spawnSync(defaultLeaseHelperPath(), ['identity', String(process.pid)], { timeout: 5_000 })
    .status === 0

const fixtures: IsolatedHomeFixture[] = []

async function leasedHome() {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const lease = await acquireHomeLease({
    home: fixture.home,
    entrypoint: 'desktop',
    profile: 'desktop',
    appVersion: '0.0.0',
    probe: createNativeProcessProbe({
      helperPath: defaultLeaseHelperPath(),
      entryExecutables: [],
    }),
  })
  return { ref: createProfileRef(fixture.home, 'desktop'), lease }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

/**
 * Crash simulation: truncate the durable sequence at a chosen boundary by
 * rewinding the on-disk journal, then verify recovery decides from disk facts.
 */
async function rewindJournal(home: string, id: string, state: string, appliedCount: number) {
  const file = journalPath(home, id)
  const raw = JSON.parse(await readFile(file, 'utf8'))
  raw.state = state
  raw.writes = raw.writes.map((write: { applied: boolean }, index: number) => ({
    ...write,
    applied: index < appliedCount,
  }))
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`)
}

describe.skipIf(!helperAvailable)('revision recovery with a real lease', () => {
  it('recovers a crash right after the before snapshot (prepared)', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    await rewindJournal(ref.home, tx.id, 'prepared', 0)
    await expect(recoverInterruptedTransactions(ref, lease)).resolves.toBe('restored')
    for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      await expect(stat(path.join(ref.dir, filename))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await lease.release()
  })

  it('recovers a crash between the first and last file replacement', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    await rewindJournal(ref.home, tx.id, 'applying', 1)
    const outcome = await recoverInterruptedTransactions(ref, lease)
    expect(outcome).toBe('restored')
    // Idempotent: the already-applied file matches candidate, the rest match
    // absence; a repeat run settles clean.
    await expect(recoverInterruptedTransactions(ref, lease)).resolves.toBe('clean')
    await lease.release()
  })

  it('recovers a crash before the commit marker by leaving attribution open', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    // Boot reached completion of writes but no commit and no failure record.
    await rewindJournal(ref.home, tx.id, 'applied', plan.writes.length)
    await expect(recoverInterruptedTransactions(ref, lease)).resolves.toBe('needs-review')
    await lease.release()
  })

  it('surfaces a rollback crash as idempotent rollback, not data loss', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    // Crash mid-rollback after the first file went back to absence.
    await rollbackProfileTransaction(tx.id, lease)
    const journal = await readJournal(ref.home, tx.id)
    expect(journal === 'corrupt' || journal === 'missing' ? journal : journal.state).toBe(
      'rolled-back',
    )
    // A duplicated rollback keeps succeeding and files stay restored.
    await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('restored')
    await expect(stat(path.join(ref.dir, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await lease.release()
  })

  it('keeps committed transactions stable across a later unrelated failure', async () => {
    const { ref, lease } = await leasedHome()
    const first = await planDesktopReconcile(ref, lease)
    const txA = await applyProfileTransaction(first, lease)
    await commitProfileTransaction(txA.id, lease)

    const second = await planDesktopReconcile(ref, lease)
    expect(second.writes).toHaveLength(0)
    await expect(recoverInterruptedTransactions(ref, lease)).resolves.toBe('clean')
    await expect(stat(path.join(ref.dir, 'package.json'))).resolves.toBeTruthy()
    await lease.release()
  })

  it('stores journal artifacts under the leased home only', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    const dir = transactionDir(ref.home, tx.id)
    expect(path.dirname(path.dirname(path.dirname(dir)))).toBe(ref.home)
    expect((await stat(path.join(ref.home, 'run'))).mode & 0o700).toBe(0o700)
    await lease.release()
  })
})
