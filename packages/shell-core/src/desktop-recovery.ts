import {
  commitProfileTransaction,
  createProfileRef,
  findAppliedTransactions,
  planDesktopReconcile,
  prepareSafeProfile,
  ProfileReconcileError,
  reconcileDesktopProfile,
  recoverInterruptedTransactions,
  retainProfileTransaction,
  rollbackProfileTransaction,
  SAFE_PROFILE_NAME,
} from '@deskwork/profile-manager'

import {
  StartupFailureError,
  type ProfilePrepareResult,
  type ProfileRecoveryPort,
} from './recovery-controller.js'
import { toStartupFailure } from './failure-policy.js'
import { quarantineProjectionCache } from './projection-cache.js'

export type DesktopRecoveryOptions = Readonly<{
  home: string
  profileName: string
  /** The app-owned profile the desktop template reconcile belongs to. */
  ownedProfileName: string
  cacheThresholdBytes?: number
}>

/**
 * The production profile-recovery port: settle interrupted journals from
 * previous runs, quarantine an oversized rebuildable cache, apply the
 * journaled reconcile, and settle the transaction on the session's verdict.
 * Every recovery write requires this run's home session.
 */
export function createDesktopProfileRecovery(options: DesktopRecoveryOptions): ProfileRecoveryPort {
  const home = options.home
  const profileName = options.profileName
  const ownedProfileName = options.ownedProfileName
  const normalRef = createProfileRef(home, profileName)
  const safeRef = createProfileRef(home, SAFE_PROFILE_NAME)
  const thresholdBytes = options.cacheThresholdBytes ?? 512 * 1024 * 1024
  return {
    async prepare(session) {
      let recovery: Awaited<ReturnType<typeof recoverInterruptedTransactions>>
      try {
        recovery = await recoverInterruptedTransactions(normalRef, session)
      } catch (error) {
        throw new StartupFailureError(
          toStartupFailure({
            stage: 'recover-transactions',
            code: 'RECOVERY_SCAN_FAILED',
            summary: error instanceof Error ? error.message : String(error),
            retryable: true,
            home,
          }),
        )
      }
      if (recovery === 'conflict') {
        return {
          kind: 'blocked',
          failure: toStartupFailure({
            stage: 'recover-transactions',
            code: 'RECOVERY_CONFLICT',
            summary:
              'a previous profile recovery found diverged files; the profile was left untouched — inspect run/profile-transactions in the DSH home (the journal records the divergence)',
            retryable: false,
            home,
          }),
        }
      }
      let cache: Awaited<ReturnType<typeof quarantineProjectionCache>>
      try {
        cache = await quarantineProjectionCache({ home, session, thresholdBytes })
      } catch (error) {
        throw new StartupFailureError(
          toStartupFailure({
            stage: 'cache-quarantine',
            code: 'CACHE_QUARANTINE_FAILED',
            summary: error instanceof Error ? error.message : String(error),
            retryable: true,
            home,
          }),
        )
      }
      if (cache.kind === 'unknown-layout') {
        // Diagnosable, never fatal: an uncertified cache layout is left
        // untouched and the structured line is greppable in diagnostics.
        console.error(
          JSON.stringify({
            kind: 'projection-cache-unknown-layout',
            cacheRelative: 'storages/session_projcache/sessions',
            action: 'left-untouched',
          }),
        )
      }
      if (cache.kind === 'quarantined') {
        // A renamed sessions cache is user-visible state: log where it went
        // (relative path and size only, never contents).
        console.error(
          JSON.stringify({
            kind: 'projection-cache-quarantined',
            backupRelative: cache.relativeBackupPath,
            bytes: cache.bytes,
          }),
        )
      }
      // A journal that reached `applied` without attribution is only adopted
      // when it is the single open one and every managed file still matches
      // the recorded candidate — the boot that follows settles it on
      // evidence, never on a guess. Anything ambiguous goes to review.
      const needsReviewBlock = (summary: string): ProfilePrepareResult => ({
        kind: 'blocked',
        failure: toStartupFailure({
          stage: 'recover-transactions',
          code: 'TRANSACTION_NEEDS_REVIEW',
          summary,
          retryable: false,
          home,
        }),
      })
      let adopted: string | undefined
      if (recovery === 'needs-review') {
        const applied = await findAppliedTransactions(normalRef)
        if (applied.length !== 1 || !applied[0]!.atCandidate) {
          return needsReviewBlock(
            'a previous startup left the profile mid-transaction without failure attribution; the profile was left untouched — inspect run/profile-transactions in the DSH home (the journal records the divergence)',
          )
        }
        adopted = applied[0]!.id
        if (profileName !== ownedProfileName) {
          // Only the app-owned profile has an app-owned plan to re-verify the
          // adopted candidate against; any other boot profile cannot prove
          // the journal still matches its desired shape — fail closed.
          return needsReviewBlock(
            'a previous startup left this non-desktop profile mid-transaction; the profile was left untouched — inspect run/profile-transactions in the DSH home (the journal records the divergence)',
          )
        }
        // The desired profile must still equal the adopted candidate: a
        // change would stack a second open journal. Detect it at PLAN time,
        // before any file is touched.
        const pending = await planDesktopReconcile(normalRef, session).catch(() => undefined)
        if (pending === undefined || pending.writes.length > 0) {
          return needsReviewBlock(
            'the desired profile changed since an interrupted startup left one mid-transaction; the profile was left untouched — inspect run/profile-transactions in the DSH home (the journal records the divergence)',
          )
        }
      }
      let result: Awaited<ReturnType<typeof reconcileDesktopProfile>> | undefined
      if (profileName === ownedProfileName) {
        try {
          result = await reconcileDesktopProfile(normalRef, session)
        } catch (error) {
          const phase = error instanceof ProfileReconcileError ? error.phase : 'apply'
          throw new StartupFailureError(
            toStartupFailure({
              stage: phase === 'plan' ? 'resolve-profile' : 'reconcile-profile',
              code: phase === 'plan' ? 'PROFILE_INVALID' : 'RECONCILE_FAILED',
              summary: error instanceof Error ? error.message : String(error),
              retryable: false,
              home,
            }),
          )
        }
      }
      // A boot profile the app does not own (packaged smoke rounds) is owned
      // by its creator — e.g. the CLI's plugin flow staged it. The app
      // recovers its interrupted transactions and quarantines the shared
      // cache, but never reconciles it against the app-owned template.
      if (result !== undefined && adopted !== undefined && result.transactionId !== undefined) {
        // Lost a race with an edit between the plan check and the apply:
        // restore the fresh transaction's files, then block for review.
        await rollbackProfileTransaction(result.transactionId, session).catch(() => undefined)
        return needsReviewBlock(
          'the desired profile changed since an interrupted startup left one mid-transaction; the profile was left untouched — inspect run/profile-transactions in the DSH home (the journal records the divergence)',
        )
      }
      const transactionId = result?.transactionId ?? adopted
      const ready: ProfilePrepareResult = {
        kind: 'ready',
        changed: (result?.changed ?? false) || adopted !== undefined,
        ...(transactionId === undefined ? {} : { transactionId }),
      }
      return ready
    },
    async settleCommitted(transactionId, session) {
      await commitProfileTransaction(transactionId, session)
    },
    async rollback(transactionId, session) {
      return rollbackProfileTransaction(transactionId, session)
    },
    async retain(transactionId, session, failure) {
      await retainProfileTransaction(transactionId, session, failure)
    },
    async enterSafeMode(session) {
      // Prepare first: a conflicting safe profile must leave the normal
      // profile exactly as it was.
      const prepared = await prepareSafeProfile(safeRef, session)
      if (prepared === 'conflict') return 'conflict'
      return 'prepared'
    },
    async exitSafeMode() {
      // Nothing to restore: the home session is not bound to a profile name.
    },
  }
}
