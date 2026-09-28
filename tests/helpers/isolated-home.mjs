import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturePrefix = 'dsh-desktop-isolated-'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function isInsideDirectory(parent, child) {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function assertOutsideForbiddenRoots(home) {
  const resolved = path.resolve(home)
  if (resolved === path.parse(resolved).root) {
    throw new Error('isolated home must never be the filesystem root')
  }
  if (isInsideDirectory(repoRoot, resolved)) {
    throw new Error('isolated home must not live inside the repository')
  }
  if (resolved === path.resolve(path.join(homedir(), '.dsh'))) {
    throw new Error('isolated home must not be the real DSH home')
  }
  if (resolved === path.resolve(path.join(homedir(), '.deskwork'))) {
    throw new Error('isolated home must not be the real Deskwork home')
  }
}

async function directoryIdentity(dirname, label) {
  const identity = await lstat(dirname)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink`)
  }
  return identity
}

/**
 * Create a throwaway DSH home for tests. The fixture refuses to run while the
 * environment already carries a non-blank `DESKWORK_HOME`, never places the home in
 * the repository, the filesystem root, or the real `~/.dsh`, and re-verifies
 * the recorded directory identity (realpath + dev/ino) before cleanup.
 */
export async function createIsolatedHomeFixture() {
  const envHome = process.env.DESKWORK_HOME
  if (envHome !== undefined && envHome.trim().length > 0) {
    throw new Error(
      'refusing to create an isolated home while DESKWORK_HOME is set in the environment; unset it and pass the temporary home explicitly (the resolver reads DESKWORK_HOME only)',
    )
  }
  const userData = await mkdtemp(path.join(tmpdir(), fixturePrefix))
  const home = path.join(userData, 'm0-dsh-home')
  assertOutsideForbiddenRoots(home)
  await mkdir(home, { mode: 0o700 })

  const userDataIdentity = await directoryIdentity(userData, 'isolated fixture userData')
  const homeIdentity = await directoryIdentity(home, 'isolated fixture home')
  const canonicalUserData = await realpath(userData)
  const canonicalHome = await realpath(home)
  const canonicalTmp = await realpath(tmpdir())
  let disposed = false

  return Object.freeze({
    home,
    userData,
    async dispose() {
      if (disposed) return
      disposed = true
      if (
        path.dirname(canonicalUserData) !== canonicalTmp ||
        !path.basename(canonicalUserData).startsWith(fixturePrefix)
      ) {
        throw new Error('refusing to clean an isolated fixture outside its temporary parent')
      }
      const currentUserData = await directoryIdentity(userData, 'isolated fixture userData')
      const currentHome = await lstat(home).catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (
        currentUserData.dev !== userDataIdentity.dev ||
        currentUserData.ino !== userDataIdentity.ino ||
        (await realpath(userData)) !== canonicalUserData
      ) {
        throw new Error('isolated fixture userData identity changed; refusing cleanup')
      }
      if (currentHome !== undefined) {
        if (
          currentHome.dev !== homeIdentity.dev ||
          currentHome.ino !== homeIdentity.ino ||
          (await realpath(home)) !== canonicalHome
        ) {
          throw new Error('isolated fixture home identity changed; refusing cleanup')
        }
      }
      await rm(userData, { recursive: true, force: true })
    },
  })
}
