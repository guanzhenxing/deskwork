import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLeaseHelperPath } from '@deskwork/home-lease'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type CliRuntimePaths = Readonly<{
  /** Official CLI entry, resolved through the package `bin.dsh` field. */
  dshBin: string
  nodeExecutable: string
  leaseHelper: string
  /**
   * Executables that indicate a supported desktop entrypoint is running.
   * Development resolves the pinned Electron binary next to the launcher;
   * packaged builds replace this with the bundled app binary.
   */
  desktopEntryExecutables: readonly string[]
  /**
   * Absolute paths matched against the argv of running processes during
   * doctor scans: our wrapper script, the authorized CLI child module, the
   * Electron Host entry, and the official dsh bin (also catches bare `dsh`).
   */
  scanArgvNeedles: readonly string[]
}>

/**
 * Where this process should read its release manifest: an installed `.app`
 * carries the embedded copy next to runtime-cli/, development reads the
 * generated manifest facts from the repository baseline document through
 * `loadReleaseManifest({ repositoryRoot })`.
 */
export function releaseManifestInput(): { resourcesDir?: string; repositoryRoot?: string } {
  const embedded = path.join(packageRoot, '..', 'compatibility.json')
  if (existsSync(embedded)) {
    return { resourcesDir: path.resolve(packageRoot, '..') }
  }
  return { repositoryRoot: path.resolve(packageRoot, '..', '..') }
}

/**
 * One-line release facts for diagnostics, read from the embedded release
 * manifest (installed `.app`) or the repository baseline document
 * (development). Undefined when no manifest can be read — diagnostics
 * degrade, they never invent version facts.
 */
export function resolveReleaseFactsLine(): string | undefined {
  const candidates = [
    // packaged: <Contents/Resources>/compatibility.json next to runtime-cli/
    path.join(packageRoot, '..', 'compatibility.json'),
    // development: <repo>/docs/compatibility.json
    path.join(packageRoot, '..', '..', 'docs', 'compatibility.json'),
  ]
  for (const candidate of candidates) {
    let facts: {
      releaseId?: unknown
      dataEpoch?: unknown
      release?: { dataEpoch?: unknown }
      dsh?: { tag?: unknown; npmVersion?: unknown }
    }
    try {
      facts = JSON.parse(readFileSync(candidate, 'utf8'))
    } catch {
      continue
    }
    const dsh = facts.dsh
    if (typeof dsh?.tag !== 'string' || typeof dsh?.npmVersion !== 'string') continue
    const epoch = [facts.dataEpoch, facts.release?.dataEpoch].find(
      (value) => typeof value === 'number',
    )
    const release =
      typeof facts.releaseId === 'string' ? ` ${facts.releaseId}` : ' development source'
    return `DSH ${dsh.tag} (npm ${dsh.npmVersion}) ·${release}${
      epoch === undefined ? '' : ` · data epoch ${epoch}`
    }`
  }
  return undefined
}

/** Resolve the official `dsh` bin through the package manifest only. */
export function resolveOfficialDshBin(): string {
  const requireHere = createRequire(path.join(packageRoot, 'package.json'))
  const manifestPath = requireHere.resolve('@deepseek-ai/dsh/package.json')
  const manifest: unknown = requireHere(manifestPath)
  const bin = (manifest as { bin?: Record<string, string> }).bin
  const relative = bin?.dsh
  if (typeof relative !== 'string' || relative === '') {
    throw new Error('the pinned @deepseek-ai/dsh package does not declare a bin.dsh entry')
  }
  return path.resolve(path.dirname(manifestPath), relative)
}

function desktopElectronBinary(): string | undefined {
  try {
    const requireLauncher = createRequire(
      path.join(packageRoot, '..', 'desktop-launcher', 'package.json'),
    )
    const resolved: unknown = requireLauncher('electron')
    return typeof resolved === 'string' ? resolved : undefined
  } catch {
    return undefined
  }
}

export function resolveCliRuntime(
  env: Readonly<Record<string, string | undefined>>,
): CliRuntimePaths {
  const entries: string[] = []
  const electron = desktopElectronBinary()
  if (electron !== undefined) entries.push(electron)
  const dshBin = resolveOfficialDshBin()
  const needles = [
    dshBin,
    path.join(packageRoot, '..', '..', 'scripts', 'dsh-native.mjs'),
    path.join(packageRoot, 'lib', 'cli-child.js'),
    path.join(packageRoot, '..', 'desktop-launcher', 'lib', 'host-entry.js'),
  ]
  return Object.freeze({
    dshBin,
    nodeExecutable: process.execPath,
    leaseHelper: resolveLeaseHelperPath(env),
    desktopEntryExecutables: Object.freeze(entries),
    scanArgvNeedles: Object.freeze(needles),
  })
}

/**
 * Runtime paths inside an installed `.app` (`Contents/Resources/runtime-cli`):
 * the official dsh bin resolves through the staged dependency closure, the
 * shim's own Node binary replaces `process.execPath` assumptions, the lease
 * helper comes from `Contents/Resources/native`, and the packaged desktop
 * executable is read from the embedded compatibility manifest — never from
 * the environment or the repository layout.
 */
export function resolvePackagedCliRuntime(
  input: Readonly<{ stagingRoot: string }>,
): CliRuntimePaths {
  // Canonicalize once: Node's package resolution realpaths the staged dsh
  // package (e.g. /var → /private/var on macOS); every derived path must use
  // the same canonical root or argv needles would mismatch between them.
  const stagingRoot = realpathSync(path.resolve(input.stagingRoot))
  const resourcesRoot = path.resolve(stagingRoot, '..')
  const requireHere = createRequire(path.join(stagingRoot, 'package.json'))
  const manifestPath = requireHere.resolve('@deepseek-ai/dsh/package.json')
  const manifest: unknown = requireHere(manifestPath)
  const bin = (manifest as { bin?: Record<string, string> }).bin
  const relative = bin?.dsh
  if (typeof relative !== 'string' || relative === '') {
    throw new Error('the staged runtime does not declare a bin.dsh entry')
  }
  const dshBin = path.resolve(path.dirname(manifestPath), relative)
  let compatibility: { productExecutableName?: unknown }
  try {
    compatibility = JSON.parse(
      readFileSync(path.join(resourcesRoot, 'compatibility.json'), 'utf8'),
    ) as { productExecutableName?: unknown }
  } catch {
    throw new Error(
      'the installed compatibility manifest is missing or corrupt; reinstall the application',
    )
  }
  if (typeof compatibility.productExecutableName !== 'string') {
    throw new Error('the embedded compatibility manifest does not name the app executable')
  }
  const appExecutable = path.resolve(
    resourcesRoot,
    '..',
    'MacOS',
    compatibility.productExecutableName,
  )
  const needles = [
    dshBin,
    path.join(stagingRoot, 'cli-entry.mjs'),
    path.join(stagingRoot, 'lib', 'cli-child.js'),
    path.join(resourcesRoot, 'runtime-host', 'lib', 'host-entry.js'),
    appExecutable,
  ]
  return Object.freeze({
    dshBin,
    nodeExecutable: path.join(stagingRoot, 'node', 'bin', 'node'),
    leaseHelper: path.join(resourcesRoot, 'native', 'lease-helper'),
    desktopEntryExecutables: Object.freeze([appExecutable]),
    scanArgvNeedles: Object.freeze(needles),
  })
}
