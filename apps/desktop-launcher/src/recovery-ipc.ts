import type { StartupFailure } from '@deskwork/shell-core'

export type RecoveryActionName = 'retry' | 'safe-mode' | 'quit'

export type RecoveryIpcView = Readonly<{
  kind: 'recovery-view'
  failure: Readonly<{
    stage: string
    code: string
    category: string
    summary: string
    retryable: boolean
  }>
  retryAllowed: boolean
  safeModeAllowed: boolean
  doctorCommand: string | null
}>

export const RECOVERY_DOCUMENT_PATH = 'recovery-view.html'

/**
 * Pure sender validation for the privileged recovery IPC. Only the exact
 * recovery window's main frame, at the exact loaded document URL, with the
 * fixed schema, while the session is in recovery, may pass. A child frame of
 * the same document — or any other window, path, or navigation — is rejected.
 */
export function validateRecoveryIpc(
  input: Readonly<{
    senderId: number | undefined
    frameUrl: string | undefined
    frameIsMainFrame: boolean | undefined
    expectedFrameUrl: string
    expectedSenderIds: ReadonlySet<number>
    inRecovery: boolean
    channel: string
    payload: unknown
  }>,
): { ok: true; action: RecoveryActionName } | { ok: false; reason: string } {
  if (!input.inRecovery) return { ok: false, reason: 'session is not in recovery' }
  if (input.senderId === undefined || !input.expectedSenderIds.has(input.senderId)) {
    return { ok: false, reason: 'sender is not the recovery window' }
  }
  if (input.channel !== 'recovery:action') {
    return { ok: false, reason: `unknown channel ${JSON.stringify(input.channel)}` }
  }
  if (input.frameUrl === undefined) return { ok: false, reason: 'missing frame url' }
  if (input.frameUrl !== input.expectedFrameUrl) {
    return { ok: false, reason: 'unexpected document url' }
  }
  if (input.frameIsMainFrame !== true) {
    return { ok: false, reason: 'sender is not the main frame' }
  }
  if (typeof input.payload !== 'object' || input.payload === null) {
    return { ok: false, reason: 'payload must be an object' }
  }
  const record = input.payload as Record<string, unknown>
  if (record.kind !== 'recovery-action') return { ok: false, reason: 'wrong payload kind' }
  if (record.action !== 'retry' && record.action !== 'safe-mode' && record.action !== 'quit') {
    return { ok: false, reason: 'unknown action' }
  }
  return { ok: true, action: record.action }
}

export function toIpcView(view: {
  failure: StartupFailure
  retryAllowed: boolean
  safeModeAllowed: boolean
  doctorCommand: string | null
}): RecoveryIpcView {
  return Object.freeze({
    kind: 'recovery-view',
    failure: Object.freeze({
      stage: view.failure.stage,
      code: view.failure.code,
      category: view.failure.category,
      summary: view.failure.summary,
      retryable: view.failure.retryable,
    }),
    retryAllowed: view.retryAllowed,
    safeModeAllowed: view.safeModeAllowed,
    doctorCommand: view.doctorCommand,
  })
}
