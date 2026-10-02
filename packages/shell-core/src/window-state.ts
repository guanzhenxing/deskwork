import { readFile } from 'node:fs/promises'

import { writeAtomicDurable } from '@deskwork/durable-fs'

export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>
export type SavedWindowState = Readonly<{ bounds: Rect; maximized: boolean }>

export const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1280, height: 820 })
export const MIN_WINDOW_SIZE = Object.freeze({ width: 900, height: 600 })

function isFiniteRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return (
    typeof rect.x === 'number' &&
    Number.isFinite(rect.x) &&
    typeof rect.y === 'number' &&
    Number.isFinite(rect.y) &&
    typeof rect.width === 'number' &&
    Number.isFinite(rect.width) &&
    typeof rect.height === 'number' &&
    Number.isFinite(rect.height)
  )
}

/** Accept only the persisted shape we wrote; anything else is absent state. */
export function parseSavedWindowState(raw: unknown): SavedWindowState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Record<string, unknown>
  if (!isFiniteRect(candidate.bounds)) return undefined
  if (typeof candidate.maximized !== 'boolean') return undefined
  return { bounds: candidate.bounds, maximized: candidate.maximized }
}

function intersects(window: Rect, area: Rect): boolean {
  return (
    window.x < area.x + area.width &&
    window.x + window.width > area.x &&
    window.y < area.y + area.height &&
    window.y + window.height > area.y
  )
}

function clampSize(width: number, height: number, host: Rect): { width: number; height: number } {
  const minWidth = Math.min(MIN_WINDOW_SIZE.width, host.width)
  const minHeight = Math.min(MIN_WINDOW_SIZE.height, host.height)
  return {
    width: Math.round(Math.min(Math.max(width, minWidth), host.width)),
    height: Math.round(Math.min(Math.max(height, minHeight), host.height)),
  }
}

function clampInto(bounds: Rect, host: Rect): Rect {
  const size = clampSize(bounds.width, bounds.height, host)
  return {
    x: Math.round(Math.min(Math.max(bounds.x, host.x), host.x + host.width - size.width)),
    y: Math.round(Math.min(Math.max(bounds.y, host.y), host.y + host.height - size.height)),
    ...size,
  }
}

/**
 * Repair a saved window state against the currently connected work areas:
 * off-screen or disconnected-display windows return to the primary area,
 * illegal sizes fall back through the 900×600 minimum to the 1280×820
 * default, and a work area smaller than the minimum clamps the window to the
 * work area itself. The maximized flag survives with the saved normal bounds.
 */
export function restoreWindowState(
  saved: SavedWindowState | undefined,
  workAreas: readonly Rect[],
): SavedWindowState {
  const areas = workAreas.filter(isFiniteRect)
  const primaryArea = areas[0]
  if (primaryArea === undefined) {
    return { bounds: { x: 0, y: 0, ...DEFAULT_WINDOW_SIZE }, maximized: false }
  }
  const host =
    saved !== undefined && isFiniteRect(saved.bounds)
      ? (areas.find((area) => intersects(saved.bounds, area)) ?? primaryArea)
      : primaryArea
  const rawBounds =
    saved !== undefined && isFiniteRect(saved.bounds)
      ? saved.bounds
      : { x: host.x, y: host.y, ...DEFAULT_WINDOW_SIZE }
  const maximized = saved?.maximized === true
  return { bounds: clampInto(rawBounds, host), maximized }
}

/**
 * The BrowserWindow minimum must follow the restored state: a work area
 * smaller than 900x600 legitimately restores a smaller window, and a fixed
 * minWidth/minHeight would push it right back past the work-area edges.
 */
export function minWindowSizeFor(restored: SavedWindowState): Readonly<{
  width: number
  height: number
}> {
  return Object.freeze({
    width: Math.min(MIN_WINDOW_SIZE.width, restored.bounds.width),
    height: Math.min(MIN_WINDOW_SIZE.height, restored.bounds.height),
  })
}

/** Closing the window hides it to the tray; only quitting may really close. */
export function closeWindowAction(quitting: boolean): 'hide' | 'close' {
  return quitting ? 'close' : 'hide'
}

export async function readWindowState(file: string): Promise<SavedWindowState | undefined> {
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (raw === undefined) return undefined
  try {
    return parseSavedWindowState(JSON.parse(raw))
  } catch {
    // Corrupt persisted state is treated exactly like absent state.
    return undefined
  }
}

/**
 * Persist only bounds/maximized through a same-directory temporary file with
 * fsync before the rename, so a crash mid-write never truncates the previous
 * state.
 */
export async function writeWindowState(file: string, state: SavedWindowState): Promise<void> {
  const payload = `${JSON.stringify(
    { bounds: state.bounds, maximized: state.maximized },
    undefined,
    2,
  )}\n`
  await writeAtomicDurable(file, Buffer.from(payload, 'utf8'))
}
