import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Keep every upstream DSH version declaration in step with the pinned baseline.
 *
 * The pinned version has exactly one source of truth — `build/upstream-artifacts.json`
 * (`dsh.npmVersion`, cross-checked by `verify:dsh-closure`). This script projects that
 * value onto the places pnpm and the workspace actually read:
 *
 *   1. `pnpm-workspace.yaml` → `overrides['@deepseek-ai/dsh*']`
 *   2. `pnpm-workspace.yaml` → `minimumReleaseAgeExclude`, one entry per DSH package (the
 *      list exists because upstream rc publishes are too new for pnpm's minimumReleaseAge)
 *   3. every `packages/*` and `apps/*` manifest depending on a `@deepseek-ai/dsh*` package
 *
 * `@deepseek-ai/cordis` is a separate version axis (the ledger's `independentPackages`)
 * and is never touched here. Entries that no longer resolve are preserved: a superset
 * costs nothing and avoids dropping a name a later closure may reintroduce.
 */

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const workspacePath = 'pnpm-workspace.yaml'
const lockfilePath = 'pnpm-lock.yaml'
const ledgerPath = 'build/upstream-artifacts.json'

const workspaceEntryPattern = /^ {2}- '(@deepseek-ai\/dsh[a-z0-9-]*)@([^']+)'$/u
const overridePattern = /^ {2}'@deepseek-ai\/dsh\*': (.+)$/u
const lockfileEntryPattern = /^ {2}'(@deepseek-ai\/dsh[a-z0-9-]*)@([^'()]+)':$/gmu
const dshDependencyPattern = /^@deepseek-ai\/dsh(?:-|$)/u
const manifestSections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

/** Read the single pinned DSH version from the artifact ledger. */
export function pinnedDshVersion(ledger) {
  const version = ledger?.dsh?.npmVersion
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${ledgerPath}: dsh.npmVersion must be a non-empty string`)
  }
  return version
}

/** Locate the contiguous `minimumReleaseAgeExclude` run that pins DSH packages. */
export function locateWorkspaceDshBlock(contents) {
  const lines = contents.split('\n')
  const indices = []
  for (const [index, line] of lines.entries()) {
    if (workspaceEntryPattern.test(line)) indices.push(index)
  }
  if (indices.length === 0) {
    throw new Error(
      `${workspacePath}: no '@deepseek-ai/dsh*' entries found in minimumReleaseAgeExclude`,
    )
  }
  const start = indices[0]
  const end = indices[indices.length - 1]
  if (end - start + 1 !== indices.length) {
    throw new Error(`${workspacePath}: the '@deepseek-ai/dsh*' entries are not contiguous`)
  }
  const names = []
  const versions = new Set()
  for (const index of indices) {
    const match = workspaceEntryPattern.exec(lines[index])
    names.push(match[1])
    versions.add(match[2])
  }
  return { lines, start, end, names, versions: [...versions] }
}

/** Every base DSH package name the lockfile resolves. */
export function lockfileDshNames(contents) {
  const names = new Set()
  for (const match of contents.matchAll(lockfileEntryPattern)) names.add(match[1])
  return names
}

/**
 * Project the pinned version onto the stored pin list.
 *
 * The stored order is preserved: the list is a concatenation of historical batches rather
 * than a sorted set, and re-sorting it would rewrite entries unrelated to a version bump.
 * Names the lockfile resolves but the list does not carry yet are appended in sorted order.
 */
export function applyWorkspacePins(contents, version, extraNames = []) {
  const block = locateWorkspaceDshBlock(contents)
  const known = new Set(block.names)
  const additions = [...new Set(extraNames)].filter((name) => !known.has(name)).sort()
  const rendered = [...block.names, ...additions].map((name) => `  - '${name}@${version}'`)
  const lines = [
    ...block.lines.slice(0, block.start),
    ...rendered,
    ...block.lines.slice(block.end + 1),
  ]
  const overrideIndex = lines.findIndex((line) => overridePattern.test(line))
  if (overrideIndex === -1) {
    throw new Error(`${workspacePath}: no '@deepseek-ai/dsh*' overrides entry found`)
  }
  if (overridePattern.exec(lines[overrideIndex])[1].trim() !== version) {
    lines[overrideIndex] = `  '@deepseek-ai/dsh*': ${version}`
  }
  return lines.join('\n')
}

/** DSH dependency versions in one manifest that disagree with the pinned version. */
export function staleManifestEntries(manifest, version) {
  const stale = []
  for (const section of manifestSections) {
    const entries = manifest?.[section]
    if (entries === undefined || entries === null) continue
    for (const [name, declared] of Object.entries(entries)) {
      if (!dshDependencyPattern.test(name)) continue
      if (declared !== version) stale.push({ section, name, declared })
    }
  }
  return stale
}

/** Rewrite one manifest's DSH dependencies to the pinned version, preserving file shape. */
export function applyManifestPins(manifest, version) {
  for (const section of manifestSections) {
    const entries = manifest?.[section]
    if (entries === undefined || entries === null) continue
    for (const name of Object.keys(entries)) {
      if (dshDependencyPattern.test(name)) entries[name] = version
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

async function readWorkspaceManifests() {
  const found = []
  for (const workspaceRoot of ['packages', 'apps']) {
    const entries = await readdir(path.join(repositoryRoot, workspaceRoot), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const relative = path.posix.join(workspaceRoot, entry.name, 'package.json')
      const contents = await readFile(path.join(repositoryRoot, relative), 'utf8').catch(
        () => undefined,
      )
      if (contents !== undefined) found.push({ relative, contents })
    }
  }
  return found.sort((left, right) => left.relative.localeCompare(right.relative))
}

async function readPinInputs() {
  const ledger = JSON.parse(await readFile(path.join(repositoryRoot, ledgerPath), 'utf8'))
  const version = pinnedDshVersion(ledger)
  const workspace = await readFile(path.join(repositoryRoot, workspacePath), 'utf8')
  const lockfile = await readFile(path.join(repositoryRoot, lockfilePath), 'utf8')
  return { version, workspace, lockfileNames: lockfileDshNames(lockfile) }
}

/** Compare every pin site against the ledger and report drift. */
export async function checkDshPins() {
  const errors = []
  const { version, workspace, lockfileNames } = await readPinInputs()

  const block = locateWorkspaceDshBlock(workspace)
  if (applyWorkspacePins(workspace, version, lockfileNames) !== workspace) {
    const drifted = block.versions.filter((declared) => declared !== version)
    const missing = [...lockfileNames].filter((name) => !block.names.includes(name)).sort()
    if (drifted.length > 0) {
      errors.push(
        `${workspacePath}: minimumReleaseAgeExclude carries ${drifted.join(', ')}, expected ${version}`,
      )
    }
    if (missing.length > 0) {
      errors.push(`${workspacePath}: lockfile packages missing a pin entry: ${missing.join(', ')}`)
    }
    if (drifted.length === 0 && missing.length === 0) {
      errors.push(`${workspacePath}: the pin block differs from the projected form`)
    }
  }
  for (const name of block.names.filter((entry) => !lockfileNames.has(entry))) {
    console.log(`note: ${name} is pinned but does not resolve in the current lockfile`)
  }
  const override = workspace.split('\n').find((line) => overridePattern.test(line))
  if (override === undefined) {
    errors.push(`${workspacePath}: no '@deepseek-ai/dsh*' overrides entry found`)
  } else if (overridePattern.exec(override)[1].trim() !== version) {
    errors.push(`${workspacePath}: overrides disagree with the ledger version ${version}`)
  }

  for (const manifest of await readWorkspaceManifests()) {
    for (const stale of staleManifestEntries(JSON.parse(manifest.contents), version)) {
      errors.push(
        `${manifest.relative}: ${stale.section}.${stale.name} is ${stale.declared}, expected ${version}`,
      )
    }
  }

  return errors
}

/** Rewrite every pin site so it carries the ledger's pinned version. */
export async function writeDshPins() {
  const { version, workspace, lockfileNames } = await readPinInputs()
  const changed = []

  const workspaceFullPath = path.join(repositoryRoot, workspacePath)
  const nextWorkspace = applyWorkspacePins(workspace, version, lockfileNames)
  if (nextWorkspace !== workspace) {
    await writeFile(workspaceFullPath, nextWorkspace)
    changed.push(workspacePath)
  }

  for (const manifest of await readWorkspaceManifests()) {
    const parsed = JSON.parse(manifest.contents)
    if (staleManifestEntries(parsed, version).length === 0) continue
    await writeFile(
      path.join(repositoryRoot, manifest.relative),
      applyManifestPins(parsed, version),
    )
    changed.push(manifest.relative)
  }

  return { version, changed }
}

async function main() {
  if (process.argv.includes('--check')) {
    const errors = await checkDshPins()
    if (errors.length > 0) {
      console.error(`DSH pin check failed with ${errors.length} error(s):`)
      for (const error of errors.sort()) console.error(`- ${error}`)
      process.exitCode = 1
      return
    }
    console.log('DSH pin check passed.')
    return
  }
  const { version, changed } = await writeDshPins()
  console.log(
    changed.length === 0
      ? `DSH pins already carry ${version}.`
      : `DSH pins set to ${version} in:\n${changed.map((file) => `- ${file}`).join('\n')}`,
  )
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}
