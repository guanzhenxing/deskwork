import { join, resolve } from 'node:path'

/**
 * Smoke runs must never fall back to the real default home: the home is
 * always derived from the dedicated smoke userData directory.
 */
export function resolveSmokeHome(input: {
  smokeMode: string | undefined
  userData: string
  osHome: string
}): string {
  if (input.smokeMode === undefined) throw new Error('smoke home requires an explicit smoke mode')
  const home = resolve(join(input.userData, 'home'))
  if (home === resolve(join(input.osHome, '.dsh'))) {
    throw new Error('smoke home must never be the real default DSH home')
  }
  return home
}
