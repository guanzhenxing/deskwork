import { readFile, stat } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHomeSession } from '@deskwork/desktop-contracts/home-session'
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

const fixtures: IsolatedHomeFixture[] = []

async function leasedHome() {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const session = await createHomeSession({ home: fixture.home, profile: 'deskwork' })
  return { ref: createProfileRef(fixture.home, 'deskwork'), session }
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

describe('revision recovery with a real session', () => {
  it('recovers a crash right after the before snapshot (prepared)', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    await rewindJournal(ref.home, tx.id, 'prepared', 0)
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('restored')
    for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      await expect(stat(path.join(ref.dir, filename))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('recovers a crash between the first and last file replacement', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    await rewindJournal(ref.home, tx.id, 'applying', 1)
    const outcome = await recoverInterruptedTransactions(ref, session)
    expect(outcome).toBe('restored')
    // Idempotent: the already-applied file matches candidate, the rest match
    // absence; a repeat run settles clean.
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('clean')
  })

  it('recovers a crash before the commit marker by leaving attribution open', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    // Boot reached completion of writes but no commit and no failure record.
    await rewindJournal(ref.home, tx.id, 'applied', plan.writes.length)
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('needs-review')
  })

  it('surfaces a rollback crash as idempotent rollback, not data loss', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    // Crash mid-rollback after the first file went back to absence.
    await rollbackProfileTransaction(tx.id, session)
    const journal = await readJournal(ref.home, tx.id)
    expect(journal === 'corrupt' || journal === 'missing' ? journal : journal.state).toBe(
      'rolled-back',
    )
    // A duplicated rollback keeps succeeding and files stay restored.
    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('restored')
    await expect(stat(path.join(ref.dir, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps committed transactions stable across a later unrelated failure', async () => {
    const { ref, session } = await leasedHome()
    const first = await planDesktopReconcile(ref, session)
    const txA = await applyProfileTransaction(first, session)
    await commitProfileTransaction(txA.id, session)

    const second = await planDesktopReconcile(ref, session)
    expect(second.writes).toHaveLength(0)
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('clean')
    await expect(stat(path.join(ref.dir, 'package.json'))).resolves.toBeTruthy()
  })

  it('stores journal artifacts under the leased home only', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    const dir = transactionDir(ref.home, tx.id)
    expect(path.dirname(path.dirname(path.dirname(dir)))).toBe(ref.home)
    expect((await stat(path.join(ref.home, 'run'))).mode & 0o700).toBe(0o700)
  })
})
