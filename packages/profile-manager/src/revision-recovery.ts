import type { HomeSession } from '@deskwork/desktop-contracts/home-session'
import path from 'node:path'

import type { ProfileRef } from './profile-ref.js'
import {
  currentSha,
  readJournal,
  readdirTransactionIds,
  rollbackProfileTransaction,
} from './revision-transaction.js'

export type RecoveryOutcome = 'clean' | 'restored' | 'conflict' | 'needs-review'

/**
 * Settle journals left behind by an interrupted startup, before any new Host
 * boot. Writes that never reached `applied` are rolled back idempotently from
 * disk facts; a journal that reached `applied` without a recorded outcome has
 * no attribution and is surfaced as needs-review instead of being guessed at.
 * Rolled-back journals are terminal state and stay within the normal
 * retention window — they are never deleted here.
 */
export async function recoverInterruptedTransactions(
  ref: ProfileRef,
  session: HomeSession,
): Promise<RecoveryOutcome> {
  if (session.home !== ref.home) {
    throw new Error('recovery requires a session bound to the transaction home')
  }

  let sawRestored = false
  const outcome = (candidate: RecoveryOutcome): RecoveryOutcome => {
    if (candidate === 'needs-review') return 'needs-review'
    if (candidate === 'conflict') return 'conflict'
    if (candidate === 'restored') sawRestored = true
    return sawRestored ? 'restored' : 'clean'
  }

  for (const id of await readdirTransactionIds(session.home)) {
    const journal = await readJournal(session.home, id)
    if (journal === 'missing') continue
    // A corrupt journal of unknown ownership is still ours to worry about:
    // needs-review, never silently skipped.
    if (journal === 'corrupt') return outcome('needs-review')
    // Ownership boundary: journals belong to the profile they recorded.
    // Another profile's transactions (a safe-mode profile, a future CLI
    // entrypoint) are never settled or rolled back from this scan — the
    // desktop entrypoint only owns the profile it was asked to recover.
    if (journal.ref.name !== ref.name) continue
    if (
      journal.state === 'committed' ||
      journal.state === 'rolled-back' ||
      journal.state === 'retained' ||
      journal.state === 'conflict'
    ) {
      if (journal.state === 'conflict') return outcome('conflict')
      continue
    }
    if (journal.state === 'applied') {
      // Boot had started but no failure attribution was recorded.
      return outcome('needs-review')
    }
    // prepared / applying / rolling-back: writes never completed a boot;
    // restore idempotently. A rolled-back-by-someone-else journal is fine.
    const result = await rollbackProfileTransaction(id, session)
    if (result === 'conflict') return outcome('conflict')
    sawRestored = true
  }
  return sawRestored ? 'restored' : 'clean'
}

/**
 * Inspect the `applied` journals that made `recoverInterruptedTransactions`
 * return needs-review. `atCandidate` is true only when every managed file is
 * still exactly at the recorded candidate digest — the precondition for the
 * launcher to adopt the transaction and settle it as committed on evidence of
 * a healthy boot, without ever guessing that the profile was at fault. More
 * than one open `applied` journal is ambiguous and must go to review.
 */
export async function findAppliedTransactions(
  ref: ProfileRef,
): Promise<readonly Readonly<{ id: string; atCandidate: boolean }>[]> {
  const applied: { id: string; atCandidate: boolean }[] = []
  for (const id of await readdirTransactionIds(ref.home)) {
    const journal = await readJournal(ref.home, id)
    if (journal === 'missing' || journal === 'corrupt' || journal.state !== 'applied') continue
    // Same ownership boundary as the recovery scan: only this profile's
    // open transactions may be adopted and eventually committed.
    if (journal.ref.name !== ref.name) continue
    let atCandidate = true
    // The journal's own recorded directory is the authoritative target; it
    // is validated to sit inside <home>/profiles/<name> by readJournal.
    for (const write of journal.writes) {
      const { sha } = await currentSha(path.join(journal.ref.dir, write.path))
      if (sha !== write.candidateSha256) {
        atCandidate = false
        break
      }
    }
    applied.push({ id, atCandidate })
  }
  return applied
}
