/**
 * The identity of one operating-system process, as far as the desktop shell
 * needs it: a pid plus the identity the Host factory recorded when it started
 * the process.
 */
export type ProcessIdentity = Readonly<{ pid: number; startIdentity: string }>

/**
 * Whether a pid is still running. `EPERM` means the process exists but is not
 * ours to signal, which still counts as alive; only `ESRCH` proves it is gone.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
