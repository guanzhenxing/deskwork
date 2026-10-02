import path from 'node:path'

const DESKTOP_HOME_DIR_NAME = '.deskwork'
const DESKTOP_HOME_ENV = 'DESKWORK_HOME'

export type DesktopHomeInput = Readonly<{
  env: Readonly<Record<string, string | undefined>>
  osHome: string
  cwd: string
}>

function expandHomePath(candidate: string, osHome: string): string {
  if (candidate === '~') return osHome
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(osHome, candidate.slice(2))
  }
  return candidate
}

/**
 * Resolve the Deskwork home the desktop entrypoints must agree on.
 *
 * Deskwork owns its home: the default is `<osHome>/.deskwork`, never the
 * official CLI's `~/.dsh`. The only override is Deskwork's own
 * `$DESKWORK_HOME`; the upstream `DSH_HOME` variable is deliberately NOT an
 * input — a stale value from another tool must never silently redirect where
 * Deskwork keeps data. `~` prefixes expand against the OS home and relative
 * values resolve against the caller cwd. This function stays pure so
 * Electron Main can inject its own env/home/cwd without importing the DSH
 * package.
 */
export function resolveDesktopHome(input: DesktopHomeInput): string {
  if (!path.isAbsolute(input.osHome))
    throw new Error('resolveDesktopHome requires an absolute osHome')
  if (!path.isAbsolute(input.cwd)) throw new Error('resolveDesktopHome requires an absolute cwd')
  const fromEnv = input.env[DESKTOP_HOME_ENV]
  const configured =
    fromEnv !== undefined && fromEnv.trim().length > 0
      ? fromEnv
      : path.join(input.osHome, DESKTOP_HOME_DIR_NAME)
  const resolved = path.resolve(input.cwd, expandHomePath(configured, input.osHome))
  if (resolved === path.parse(resolved).root) {
    throw new Error('DSH home must not resolve to the filesystem root')
  }
  return resolved
}
