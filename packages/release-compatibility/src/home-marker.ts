import { readFileSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomicDurable } from '@deskwork/durable-fs'
import type { HomeSession } from '@deskwork/desktop-contracts/home-session'

import {
  HomeAdmissionError,
  markerPath,
  parseHomeCompatibilityMarker,
  readHomeCompatibilityMarker,
  type HomeCompatibilityMarker,
} from './home-admission.js'
import { parseReleaseManifest, type ReleaseManifest } from './manifest.js'

/** The unified verdict every supported entrypoint acts on. */
export type HomePreflightVerdict =
  'allow' | 'unknown-schema' | 'unsupported-data' | 'migration-required'

/**
 * The allow decision the chain hands to the marker reservation. Since
 * cross-product format admission was dropped, the formats map is always
 * empty: the marker records only the epoch facts.
 */
export type HomeAdmissionAllowance = Readonly<{
  kind: 'allow'
  dataEpoch: number
  formats: Readonly<Record<string, string>>
}>

/**
 * Reserve the release's write epoch on the home BEFORE any new-format write:
 * the schema-1 marker records the candidate epoch, this releaseId, and the
 * observed format signatures. Failing afterwards never rewinds the epoch —
 * a crash mid-write must make later releases suspect partial new-format data,
 * not silently treat the home as old.
 *
 * The session must belong to this home; reserving for a home this run does
 * not own is refused. A symlinked run/ directory or an existing marker that
 * is not a regular file refuses (fail closed).
 */
export async function reserveHomeWrite(input: {
  home: string
  session: HomeSession
  release: ReleaseManifest
  decision: HomeAdmissionAllowance
}): Promise<void> {
  if (input.session.home !== input.home) {
    throw new HomeAdmissionError(
      'MARKER_UNREADABLE',
      'write reservation requires the session of the same home',
    )
  }
  const run = path.join(input.home, 'run')
  const runIdentity = await lstat(run).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (runIdentity !== undefined && (runIdentity.isSymbolicLink() || !runIdentity.isDirectory())) {
    throw new HomeAdmissionError('MARKER_SYMLINK', 'run/ must be a real directory')
  }
  await mkdir(run, { recursive: true })
  const marker: HomeCompatibilityMarker = {
    schemaVersion: 1,
    dataEpoch: input.decision.dataEpoch,
    lastWriterReleaseId: input.release.releaseId,
    formats: { ...input.decision.formats },
  }
  await writeAtomicDurable(
    markerPath(input.home),
    Buffer.from(`${JSON.stringify(marker, undefined, 2)}\n`, 'utf8'),
  )
}

/**
 * The admission chain every supported entrypoint runs: parse the marker and
 * check its schema version and data epoch, then reserve the write epoch.
 * Since cross-product format admission was dropped, no on-disk format
 * inspection happens: the marker's own facts are the only admission input.
 * Call it before any profile/cache/Host write (or with `reserve: false` on
 * read-only paths that never write). Read failures throw
 * `HomeAdmissionError` and must be treated as refusals.
 */
export async function runHomeCompatibilityChain(input: {
  home: string
  release: ReleaseManifest
  session?: HomeSession
  /** True when this entrypoint is about to write the home. */
  reserve: boolean
}): Promise<HomePreflightVerdict> {
  if (input.reserve && input.session === undefined) {
    throw new HomeAdmissionError(
      'MARKER_UNREADABLE',
      'reserving a write epoch requires the home session',
    )
  }
  const raw = await readHomeCompatibilityMarker(input.home)
  if (raw !== null && parseHomeCompatibilityMarker(raw) === undefined) {
    return 'unknown-schema'
  }
  const marker =
    raw === null ? null : (parseHomeCompatibilityMarker(raw) as HomeCompatibilityMarker)
  // Epoch decision order matches the compatibility protocol: a newer epoch is
  // data this release must not downgrade onto; an older supported epoch needs
  // a migration this release does not perform automatically.
  if (marker !== null && !input.release.supportedDataEpochs.includes(marker.dataEpoch)) {
    return 'unsupported-data'
  }
  if (marker !== null && marker.dataEpoch < input.release.dataEpoch) {
    return 'migration-required'
  }
  if (input.reserve) {
    await reserveHomeWrite({
      home: input.home,
      session: input.session!,
      release: input.release,
      decision: { kind: 'allow', dataEpoch: input.release.dataEpoch, formats: {} },
    })
  }
  return 'allow'
}

/**
 * Load this release's manifest. Packaged builds read the embedded manifest
 * from the resources directory; development assembles the release facts from
 * the package constants (gate-bound to the authored policy) plus the
 * repository baseline document, marking the releaseId as development source.
 * Both paths end in the strict parser, so a corrupt embedded manifest refuses
 * to boot rather than degrading.
 */
export function loadReleaseManifest(input: {
  /** Directory holding the embedded compatibility.json (packaged). */
  resourcesDir?: string
  /** Repository root (development). */
  repositoryRoot?: string
}): ReleaseManifest {
  if (input.resourcesDir !== undefined) {
    const embedded = path.join(input.resourcesDir, 'compatibility.json')
    const parsed: unknown = JSON.parse(readFileSync(embedded, 'utf8'))
    return parseReleaseManifest(parsed)
  }
  const root = input.repositoryRoot ?? defaultRepositoryRoot()
  // Development assembles the manifest from the same authored sources the
  // generator consumes — docs/compatibility.json (baseline facts) and the
  // compatibility policy (formats/epochs) — so no second version truth can
  // drift in. The strict parser validates the result like any embedded copy.
  const readJson = (relative: string): unknown =>
    JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
  const docsCompatibility = readJson('docs/compatibility.json') as {
    dsh?: unknown
    hostControl?: unknown
    profile?: { schemaVersion?: unknown }
  }
  const policy = readJson('build/compatibility-policy.json') as {
    dataEpoch?: unknown
    supportedDataEpochs?: unknown
    pluginApi?: { strategy?: unknown; singletonPackages?: unknown }
    formats?: unknown
  }
  const dsh = docsCompatibility.dsh
  const dshNpmVersion =
    typeof (dsh as { npmVersion?: unknown } | undefined)?.npmVersion === 'string'
      ? (dsh as { npmVersion: string }).npmVersion
      : 'development'
  return parseReleaseManifest({
    schemaVersion: 2,
    releaseId: 'dev-source',
    desktopVersion: '0.0.0',
    sourceCommit: '0'.repeat(40),
    dsh,
    // The strict parser refuses anything but darwin — a development loader on
    // an unsupported platform is an error, not a lie in the marker.
    platform: process.platform as ReleaseManifest['platform'],
    arch: process.arch === 'x64' ? 'x64' : 'arm64',
    hostControl: docsCompatibility.hostControl,
    profileSchemaVersion: docsCompatibility.profile?.schemaVersion,
    pluginApi: {
      strategy: policy.pluginApi?.strategy,
      dshVersion: dshNpmVersion,
      singletonPackages: policy.pluginApi?.singletonPackages,
    },
    formats: policy.formats,
    dataEpoch: policy.dataEpoch,
    supportedDataEpochs: policy.supportedDataEpochs,
    // Development manifests carry no closure/patch digests — those belong to
    // generated release manifests (generate:compatibility) and are verified
    // there. The zeros make the "no claim" state explicit and parse-stable.
    dependencyClosureSha256: '0'.repeat(64),
    patchManifestSha256: '0'.repeat(64),
  })
}

function defaultRepositoryRoot(): string {
  // <root>/packages/release-compatibility/lib/home-marker.js → <root>
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}
