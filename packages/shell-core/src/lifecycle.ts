import type { HostReady } from '@deskwork/host-supervisor'

/** One bounded Host run; retries must create a fresh attempt, not restart one. */
export interface HostAttempt {
  start(): Promise<HostReady>
  stop(reason: 'quit' | 'restart', deadlineMs: number): Promise<void>
}
