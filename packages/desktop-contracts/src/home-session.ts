import { randomUUID } from 'node:crypto'

/**
 * The single application run's claim on one DSH home.
 *
 * Deskwork has exactly one supported entrypoint, so "who may write this home"
 * is a process-local invariant rather than a cross-process protocol: the
 * launcher builds one session at startup and hands it to every component that
 * writes. Nothing here takes a lock; mutual exclusion between Desktop
 * instances comes from Electron's single-instance lock, and per-file write
 * safety comes from atomic replacement.
 *
 * `generation` is the random per-run identity carried on the Host-control
 * protocol, so a Host left over from an earlier run can never be mistaken for
 * the current one.
 */
export type HomeSession = Readonly<{
  home: string
  generation: string
  profile: string
}>

export type CreateHomeSessionInput = Readonly<{
  home: string
  profile: string
  /** Test seam: supply a fixed generation instead of a fresh random one. */
  generation?: string
}>

const homeSessionBrand = Symbol('HomeSession')

export function createHomeSession(input: CreateHomeSessionInput): HomeSession {
  if (input.home.trim() === '') {
    throw new Error('a home session requires an explicit home')
  }
  if (input.profile.trim() === '') {
    throw new Error('a home session requires an explicit profile')
  }
  return Object.freeze({
    home: input.home,
    generation: input.generation ?? randomUUID(),
    profile: input.profile,
    [homeSessionBrand]: true as const,
  })
}

/**
 * Structural check for genuine {@link createHomeSession} results. Consumers
 * that gate writes on "this run owns the home" must use this instead of
 * trusting a plain `{ home, generation, profile }` literal.
 */
export function isHomeSession(value: unknown): value is HomeSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[homeSessionBrand] === true &&
    typeof (value as HomeSession).home === 'string' &&
    typeof (value as HomeSession).generation === 'string' &&
    typeof (value as HomeSession).profile === 'string'
  )
}
