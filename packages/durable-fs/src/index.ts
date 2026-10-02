import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Refuse user-planted symlinks on any directory this package writes through:
 * every existing level of a writable path must be a real directory, and a
 * freshly created level is verified right after creation. ENOENT returns
 * false so callers can create-then-reverify.
 */
export async function assertRealDirectory(dirname: string, label: string): Promise<boolean> {
  const identity = await lstat(dirname).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (identity === undefined) return false
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink`)
  }
  return true
}

export async function syncDirectory(dirname: string): Promise<void> {
  const handle = await open(dirname, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * fsync'd temp file + atomic rename; readers see old or new, never partial.
 *
 * The containing directory is created when missing: a journal or marker that
 * cannot be written because a sibling component has not created `run/` yet is
 * a footgun this primitive exists to remove. Callers that must refuse a
 * symlinked parent still check it themselves before calling.
 */
export async function writeAtomicDurable(filename: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filename)
  } catch (error) {
    // Never leak the temp file when the atomic swap itself fails: a stray
    // *.tmp entry inside profiles/<name> or desktop-safe-mode reads back as
    // a conflict and blocks Safe Mode until it is removed by hand.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  const written = await open(filename, 'r')
  try {
    await written.sync()
  } finally {
    await written.close()
  }
  await syncDirectory(path.dirname(filename))
}
