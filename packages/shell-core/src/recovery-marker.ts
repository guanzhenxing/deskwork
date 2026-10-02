import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { syncDirectory, writeAtomicDurable } from '@deskwork/durable-fs'

export type RecoveryMarker = Readonly<{ transactionId: string; attempt: number }>

type StoredMarker = Readonly<{ schemaVersion: 1 } & RecoveryMarker>

/**
 * Marker store for the single automatic profile-recovery relaunch, scoped to
 * one home by an anonymous digest of its path. The on-disk format is
 * versioned (`schemaVersion: 1`).
 *
 * A file this build cannot parse or does not recognize — corrupt bytes or a
 * future schema — is treated as "budget spent" and is never rewritten or
 * deleted: only a marker this build wrote and can read is ever cleared, and
 * only after a healthy session proves the budget was well spent.
 */
export function createRecoveryMarkerStore(userData: string, home: string) {
  const digest = createHash('sha256').update(home).digest('hex').slice(0, 16)
  const directory = path.join(userData, 'recovery')
  const file = path.join(directory, `${digest}.json`)

  /** `absent`, or the parsed value plus whether this build owns the format. */
  const readRaw = async (): Promise<
    { state: 'absent' } | { state: 'known'; marker: StoredMarker } | { state: 'foreign' }
  > => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return { state: 'foreign' }
    }
    if (typeof value !== 'object' || value === null) return { state: 'foreign' }
    const record = value as Record<string, unknown>
    if (
      record.schemaVersion === 1 &&
      typeof record.transactionId === 'string' &&
      record.transactionId.length > 0 &&
      typeof record.attempt === 'number' &&
      Number.isSafeInteger(record.attempt) &&
      record.attempt > 0
    ) {
      return { state: 'known', marker: value as StoredMarker }
    }
    return { state: 'foreign' }
  }

  return {
    /**
     * `undefined` means no marker file at all. Any present file — including
     * corrupt bytes or an unknown future schema — reads as an object so the
     * relaunch budget stays spent until a healthy session of this build
     * clears it.
     */
    async read(): Promise<unknown> {
      const current = await readRaw()
      if (current.state === 'absent') return undefined
      if (current.state === 'known') return current.marker
      return { schemaVersion: 'unknown' }
    },
    async write(marker: RecoveryMarker): Promise<void> {
      const existing = await readRaw()
      if (existing.state === 'foreign') return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeAtomicDurable(
        file,
        Buffer.from(
          `${JSON.stringify({ schemaVersion: 1, ...marker } satisfies StoredMarker, null, 2)}\n`,
          'utf8',
        ),
      )
    },
    async clear(): Promise<void> {
      // Only this build's own format is ever removed; anything else on disk
      // stays exactly as it is. The removal is made durable (directory
      // fsync) so a power loss cannot resurrect a cleared marker and wrongly
      // spend a future session's relaunch budget.
      const existing = await readRaw()
      if (existing.state !== 'known') return
      await rm(file, { force: true })
      await syncDirectory(directory)
    },
  }
}
