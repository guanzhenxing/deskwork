import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHomeSession, type HomeSession } from '@deskwork/desktop-contracts/home-session'
import { createProfileRef } from '../src/index.js'
import { planDesktopReconcile } from '../src/reconcile-plan.js'
import {
  applyProfileTransaction,
  commitProfileTransaction,
  pruneRetainedTransactions,
  readJournal,
  retainProfileTransaction,
  rollbackProfileTransaction,
  transactionDir,
  transactionsRoot,
} from '../src/revision-transaction.js'
import {
  findAppliedTransactions,
  recoverInterruptedTransactions,
} from '../src/revision-recovery.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const fixtures: IsolatedHomeFixture[] = []

async function leasedHome(): Promise<{
  ref: ReturnType<typeof createProfileRef>
  session: HomeSession
}> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const home = fixture.home
  const session = await createHomeSession({ home: home, profile: 'deskwork' })
  return { ref: createProfileRef(home, 'deskwork'), session }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe('revision transactions', () => {
  it('records before revisions, applies candidates, and commits', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    expect(plan.writes.map((write) => write.path)).toEqual([
      'package.json',
      'cordis.patch.yml',
      'pnpm-workspace.yaml',
    ])
    for (const write of plan.writes) {
      expect(write.before.exists).toBe(false)
      expect(write.beforeBytes).toBeNull()
    }
    const tx = await applyProfileTransaction(plan, session)
    expect(tx.state).toBe('applied')
    const manifest = await readFile(path.join(ref.dir, 'package.json'), 'utf8')
    expect(() => JSON.parse(manifest)).not.toThrow()
    await commitProfileTransaction(tx.id, session)
    const committed = await readJournal(ref.home, tx.id)
    expect(committed === 'corrupt' || committed === 'missing' ? committed : committed.state).toBe(
      'committed',
    )
  })

  it('refuses rollback and keeps user bytes when a candidate drifted', async () => {
    const { ref, session } = await leasedHome()
    await applyFullInitial(ref, session)
    // A second reconcile that would rewrite the manifest (wrong bundle order).
    const raw = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    raw.dsh.profile.bundles = ['@fixture/added', ...raw.dsh.profile.bundles]
    await writeFile(path.join(ref.dir, 'package.json'), `${JSON.stringify(raw, null, 2)}\n`)
    const plan = await planDesktopReconcile(ref, session)
    expect(plan.writes.map((write) => write.path)).toEqual(['package.json'])
    const tx = await applyProfileTransaction(plan, session)
    // The user edits the candidate before rollback.
    await writeFile(path.join(ref.dir, 'package.json'), '{"userChanged":true}\n')
    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('conflict')
    expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8')).toBe(
      '{"userChanged":true}\n',
    )
    const conflicted = await readJournal(ref.home, tx.id)
    expect(
      conflicted === 'corrupt' || conflicted === 'missing' ? conflicted : conflicted.state,
    ).toBe('conflict')
  })

  it('restores pre-existing bytes on rollback and never touches other files', async () => {
    const { ref, session } = await leasedHome()
    await applyFullInitial(ref, session)
    const originalManifest = await readFile(path.join(ref.dir, 'package.json'), 'utf8')
    // User-owned patch content must survive a later manifest-only transaction.
    const userPatch = '# user layer\n- id: mine\n  name: "@fixture/mine"\n'
    await writeFile(path.join(ref.dir, 'cordis.patch.yml'), userPatch)

    const raw = JSON.parse(originalManifest)
    raw.dsh.profile.bundles = ['@fixture/another', ...raw.dsh.profile.bundles]
    const userEdited = `${JSON.stringify(raw, null, 2)}\n`
    await writeFile(path.join(ref.dir, 'package.json'), userEdited)
    const plan = await planDesktopReconcile(ref, session)
    expect(plan.writes.map((write) => write.path)).toEqual(['package.json'])
    expect(plan.writes[0]?.before.exists).toBe(true)
    const tx = await applyProfileTransaction(plan, session)

    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('restored')
    // Rollback restores exactly the pre-transaction bytes — the user's own
    // edit, not the older original — and never touches other files.
    expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8')).toBe(userEdited)
    expect(await readFile(path.join(ref.dir, 'cordis.patch.yml'), 'utf8')).toBe(userPatch)
    // Rollback is idempotent and repeatable without error.
    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('restored')
  })

  it('deletes only files this transaction created and only when they still match', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    // Simulate a crash before boot: state is applied, rollback removes the
    // freshly created files.
    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('restored')
    for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      await expect(stat(path.join(ref.dir, filename))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('treats a created-path symlink as drift instead of absence', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    const outside = path.join(ref.home, '..', 'profile-drift-target')
    await mkdir(outside, { recursive: true, mode: 0o700 })
    await unlink(path.join(ref.dir, 'package.json'))
    await symlink(outside, path.join(ref.dir, 'package.json'), 'file')
    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('conflict')
    const journal = await readJournal(ref.home, tx.id)
    expect(journal === 'corrupt' || journal === 'missing' ? journal : journal.state).toBe(
      'conflict',
    )
  })

  it('retained transactions are never rolled back by startup recovery', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    await retainProfileTransaction(tx.id, session, {
      category: 'home-config',
      code: 'HOME_PATCH_INVALID',
    })
    const outcome = await recoverInterruptedTransactions(ref, session)
    expect(outcome).toBe('clean')
    const retained = await readJournal(ref.home, tx.id)
    expect(retained === 'corrupt' || retained === 'missing' ? retained : retained.state).toBe(
      'retained',
    )
    await expect(stat(path.join(ref.dir, 'package.json'))).resolves.toBeTruthy()
  })

  it('an applied transaction without attribution surfaces as needs-review', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    await applyProfileTransaction(plan, session)
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('needs-review')
    // The files stay in place: no guessing that the profile was at fault.
    await expect(stat(path.join(ref.dir, 'package.json'))).resolves.toBeTruthy()
  })

  it('recovers prepared and applying journals idempotently before boot', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    // Rewind the journal to 'applying' to simulate a crash mid-application.
    const journalFile = path.join(transactionDir(ref.home, tx.id), 'transaction.json')
    const raw = JSON.parse(await readFile(journalFile, 'utf8'))
    raw.state = 'applying'
    raw.writes = raw.writes.map((write: { path: string }, index: number) => ({
      ...write,
      applied: index === 0,
    }))
    await writeFile(journalFile, `${JSON.stringify(raw, null, 2)}\n`)

    const outcome = await recoverInterruptedTransactions(ref, session)
    expect(outcome).toBe('restored')
    for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      await expect(stat(path.join(ref.dir, filename))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    // Recovery is idempotent.
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('clean')
  })

  it('keeps rolled-back journals as terminal records within retention', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('restored')
    // Terminal journals are retained for diagnosis, never deleted by recovery.
    const journal = await readJournal(ref.home, tx.id)
    expect(journal === 'corrupt' || journal === 'missing' ? journal : journal.state).toBe(
      'rolled-back',
    )
    await expect(stat(transactionDir(ref.home, tx.id))).resolves.toBeTruthy()
  })

  it('completes a crash-interrupted rollback idempotently from the rolling-back state', async () => {
    const { ref, session } = await leasedHome()
    await applyFullInitial(ref, session)
    const original = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    original.dsh.profile.bundles = ['@fixture/x', ...original.dsh.profile.bundles]
    const userEdited = `${JSON.stringify(original, null, 2)}\n`
    await writeFile(path.join(ref.dir, 'package.json'), userEdited)
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    // Crash right after the rolling-back journal write: phase-2 re-verification
    // must still recognize the untouched candidate and restore it.
    const journalFile = path.join(transactionDir(ref.home, tx.id), 'transaction.json')
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { state: string }
    journal.state = 'rolling-back'
    await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`)
    await expect(rollbackProfileTransaction(tx.id, session)).resolves.toBe('restored')
    // The pre-transaction bytes (the user's own edit) come back byte-exact.
    expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8')).toBe(userEdited)
  })

  it('treats a journal whose recorded profile escapes the home as corrupt', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    // Tamper: point the journal's ref at a directory outside this home.
    const journalFile = path.join(transactionDir(ref.home, tx.id), 'transaction.json')
    const raw = JSON.parse(await readFile(journalFile, 'utf8')) as { ref: { dir: string } }
    raw.ref.dir = path.join(ref.home, '..', 'escaped-profile')
    await writeFile(journalFile, `${JSON.stringify(raw, null, 2)}\n`)
    expect(await readJournal(ref.home, tx.id)).toBe('corrupt')
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('needs-review')
  })

  it('skips stray files in the transactions root and treats unknown states as corrupt', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    // A Finder-dropped file in the transactions root is not a journal: the
    // scan skips it instead of failing every future startup.
    await writeFile(path.join(ref.home, 'run', 'profile-transactions', '.DS_Store'), 'junk')
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('needs-review')
    // A journal with an unrecognized state (bit rot) is corrupt — needs
    // review, never silently rolled back as if it had never booted.
    const journalFile = path.join(transactionDir(ref.home, tx.id), 'transaction.json')
    const raw = JSON.parse(await readFile(journalFile, 'utf8')) as { state: string }
    raw.state = 'garbage-state'
    await writeFile(journalFile, `${JSON.stringify(raw, null, 2)}\n`)
    expect(await readJournal(ref.home, tx.id)).toBe('corrupt')
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('needs-review')
  })

  it('reports a plan-to-apply drift as a conflict transaction', async () => {
    const { ref, session } = await leasedHome()
    await applyFullInitial(ref, session)
    // Stage a change the next plan will want to write, then drift the file
    // between plan and apply — the exact window reconcileUnderLease shields
    // by refusing to boot a conflict transaction.
    const manifest = path.join(ref.dir, 'package.json')
    const raw = JSON.parse(await readFile(manifest, 'utf8'))
    raw.dsh.profile.bundles = ['@fixture/drift', ...raw.dsh.profile.bundles]
    await writeFile(manifest, `${JSON.stringify(raw, null, 2)}\n`)
    const plan = await planDesktopReconcile(ref, session)
    expect(plan.writes.length).toBeGreaterThan(0)
    await writeFile(manifest, '{"userChanged":true}\n')
    const tx = await applyProfileTransaction(plan, session)
    expect(tx.state).toBe('conflict')
    // The drifted user bytes are exactly what stays on disk.
    expect(await readFile(manifest, 'utf8')).toBe('{"userChanged":true}\n')
  })

  it('never settles or rolls back another profile\u2019s transactions', async () => {
    const { ref, session } = await leasedHome()
    // Build an interrupted transaction owned by a different profile —
    // planDesktopReconcile only owns the app-owned profile, so hand-craft the plan the
    // way another entrypoint's journal would look on disk.
    const otherRef = createProfileRef(ref.home, 'other')
    const otherPlan = {
      ref: otherRef,
      writes: [
        {
          path: 'package.json',
          before: { exists: false, sha256: null },
          beforeBytes: null,
          candidateBytes: new TextEncoder().encode('{}\n'),
          candidateSha256: '0'.repeat(64),
        },
      ],
    } as unknown as Parameters<typeof applyProfileTransaction>[0]
    const otherTx = await applyProfileTransaction(otherPlan, session)
    // The desktop recovery scan only owns the profile it was asked about.
    await expect(recoverInterruptedTransactions(ref, session)).resolves.toBe('clean')
    const journal = await readJournal(ref.home, otherTx.id)
    expect(journal === 'corrupt' || journal === 'missing' ? journal : journal.state).toBe('applied')
    // Its files stay exactly where the other profile left them.
    await expect(stat(path.join(otherRef.dir, 'package.json'))).resolves.toBeTruthy()
    const adopted = await findAppliedTransactions(ref)
    expect(adopted).toHaveLength(0)
  })

  it('refuses to journal through a symlinked transactions root', async () => {
    const { ref, session } = await leasedHome()
    const outside = path.join(ref.home, '..', 'tx-outside')
    await mkdir(outside, { recursive: true, mode: 0o700 })
    const runDir = path.join(ref.home, 'run')
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    const { symlink } = await import('node:fs/promises')
    await symlink(outside, path.join(runDir, 'profile-transactions'), 'dir')
    const plan = await planDesktopReconcile(ref, session)
    await expect(applyProfileTransaction(plan, session)).rejects.toThrow(/symlink/u)
    // Nothing escaped: the outside directory stays empty.
    const entries = await (await import('node:fs/promises')).readdir(outside)
    expect(entries).toHaveLength(0)
  })

  it('refuses a profile parent replaced by a symlink before apply', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const outside = path.join(ref.home, '..', 'profiles-outside')
    await mkdir(outside, { recursive: true, mode: 0o700 })
    await symlink(outside, path.join(ref.home, 'profiles'), 'dir')
    await expect(applyProfileTransaction(plan, session)).rejects.toThrow(/symlink/u)
    await expect(stat(path.join(outside, 'desktop', 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await unlink(path.join(ref.home, 'profiles'))
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses plans that reference anything outside the whitelist', async () => {
    const { ref, session } = await leasedHome()
    const smuggled = {
      ...ref,
      dir: path.join(ref.home, 'profiles', 'deskwork'),
    }
    const plan = {
      ref: smuggled,
      writes: [
        {
          path: '../../outside.json',
          before: { exists: false, sha256: null },
          beforeBytes: null,
          candidateBytes: new TextEncoder().encode('{}\n'),
          candidateSha256: '0'.repeat(64),
        },
      ],
    } as unknown as Parameters<typeof applyProfileTransaction>[0]
    await expect(applyProfileTransaction(plan, session)).rejects.toThrow(/whitelisted/u)
    // Refused before any side effect: no journal directory was created.
    await expect(stat(path.join(ref.home, 'run', 'profile-transactions'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps journal snapshots private and stores only whitelisted relative paths', async () => {
    const { ref, session } = await leasedHome()
    const plan = await planDesktopReconcile(ref, session)
    const tx = await applyProfileTransaction(plan, session)
    const journal = await readJournal(ref.home, tx.id)
    if (journal === 'corrupt' || journal === 'missing') throw new Error('journal unreadable')
    for (const write of journal.writes) {
      expect(['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']).toContain(write.path)
    }
    const dirIdentity = await stat(transactionDir(ref.home, tx.id))
    expect(dirIdentity.mode & 0o777).toBe(0o700)
  })
})

async function applyFullInitial(
  ref: ReturnType<typeof createProfileRef>,
  session: HomeSession,
): Promise<void> {
  const plan = await planDesktopReconcile(ref, session)
  const tx = await applyProfileTransaction(plan, session)
  await commitProfileTransaction(tx.id, session)
}

describe('pruneRetainedTransactions', () => {
  function terminalJournal(home: string, id: string, createdAt: string): string {
    return JSON.stringify({
      schemaVersion: 1,
      id,
      ref: { home, name: 'deskwork', dir: path.join(home, 'profiles', 'deskwork') },
      state: 'committed',
      createdAt,
      writes: [],
    })
  }

  function uuid(index: number): string {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  }

  async function seedTerminalJournals(home: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const dir = transactionDir(home, uuid(index))
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(
        path.join(dir, 'transaction.json'),
        terminalJournal(
          home,
          uuid(index),
          `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        ),
      )
    }
  }

  it('keeps the newest RETAINED_TRANSACTION_LIMIT terminal transactions', async () => {
    const { ref } = await leasedHome()
    await seedTerminalJournals(ref.home, 22)
    await pruneRetainedTransactions(ref.home)
    // 22 seeded - 20 retained = the 2 oldest gone, the rest present.
    expect(await readJournal(ref.home, uuid(0))).toBe('missing')
    expect(await readJournal(ref.home, uuid(1))).toBe('missing')
    expect((await readJournal(ref.home, uuid(2))) !== 'missing').toBe(true)
  })

  it('never deletes through a symlinked transaction directory', async () => {
    const { ref } = await leasedHome()
    await seedTerminalJournals(ref.home, 22)
    // Redirect the oldest excess id at a directory outside the home.
    const outside = path.join(path.dirname(ref.home), 'outside-canary')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'payload.txt'), 'untouched\n')
    await rm(transactionDir(ref.home, uuid(0)), { recursive: true, force: true })
    await symlink(outside, transactionDir(ref.home, uuid(0)))
    // The journal itself stays valid: the leaf is a directory again, so
    // only the prune-side chain check can stop the redirected delete.
    await writeFile(
      path.join(transactionDir(ref.home, uuid(0)), 'transaction.json'),
      terminalJournal(ref.home, uuid(0), '2026-01-01T00:00:00Z'),
    )
    await pruneRetainedTransactions(ref.home)
    expect(await readFile(path.join(outside, 'payload.txt'), 'utf8')).toBe('untouched\n')
    expect((await lstat(transactionDir(ref.home, uuid(0)))).isSymbolicLink()).toBe(true)
    // The real excess directory is still pruned.
    expect(await readJournal(ref.home, uuid(1))).toBe('missing')
    await rm(outside, { recursive: true, force: true })
  })

  it('prunes nothing when the transactions root is a redirected symlink', async () => {
    const { ref } = await leasedHome()
    await seedTerminalJournals(ref.home, 22)
    const root = transactionsRoot(ref.home)
    const outside = path.join(path.dirname(ref.home), 'outside-root')
    await mkdir(outside, { recursive: true })
    // Swap the real root for a symlink to an outside directory that also
    // holds a canary the prune must never touch.
    const canary = path.join(outside, 'canary.txt')
    await writeFile(canary, 'untouched\n')
    const realRoot = `${root}.real`
    await rename(root, realRoot)
    await symlink(outside, root)
    let canaryContent: string | undefined
    try {
      await pruneRetainedTransactions(ref.home)
      canaryContent = await readFile(canary, 'utf8')
    } finally {
      await unlink(root)
      await rename(realRoot, root)
      await rm(outside, { recursive: true, force: true })
    }
    expect(canaryContent).toBe('untouched\n')
  })
})
