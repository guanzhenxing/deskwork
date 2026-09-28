/**
 * Release compatibility manifest (schema 2): the machine-readable facts every
 * packaged candidate carries. This schema is independent of the home
 * compatibility marker (schema 1, see home-admission.ts) — the two version
 * spaces must never be mixed or compared.
 *
 * The embedded manifest is a superset: staging adds runtime facts
 * (executable/app id, Electron/Node/pnpm, per-closure digests) around these
 * release facts, and parseReleaseManifest deliberately tolerates those extra
 * keys while strictly validating the release core.
 */

export type FormatRule = Readonly<{
  provider: string
  providerVersion: string
  formatId: string
  readable: readonly string[]
  writable: string
  evidence: readonly string[]
}>

export type ReleaseManifest = Readonly<{
  schemaVersion: 2
  releaseId: string
  desktopVersion: string
  sourceCommit: string
  dsh: Readonly<{ tag: string; commit: string; npmVersion: string }>
  platform: 'darwin'
  arch: 'arm64' | 'x64'
  hostControl: Readonly<{ major: number; minor: number }>
  profileSchemaVersion: number
  pluginApi: Readonly<{
    strategy: 'verified-exact-baseline'
    dshVersion: string
    singletonPackages: readonly string[]
  }>
  formats: readonly FormatRule[]
  dataEpoch: number
  supportedDataEpochs: readonly number[]
  dependencyClosureSha256: string
  patchManifestSha256: string
}>

export const RELEASE_MANIFEST_SCHEMA_VERSION = 2

/** The only platform this product builds and ships (§9 of the master plan). */
const SUPPORTED_PLATFORMS = ['darwin'] as const
const SUPPORTED_ARCHES = ['arm64', 'x64'] as const
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export class ManifestSchemaError extends Error {
  constructor(message: string) {
    super(`release manifest: ${message}`)
    this.name = 'ManifestSchemaError'
  }
}

/**
 * Strict fail-closed parse of a release manifest. Any absent, mistyped, or
 * self-inconsistent fact refuses the manifest — the caller must treat a throw
 * as "this artifact cannot prove what it ships" and refuse to trust it.
 */
export function parseReleaseManifest(input: unknown): ReleaseManifest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ManifestSchemaError('manifest must be a JSON object')
  }
  const raw = input as Record<string, unknown>
  if (raw.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new ManifestSchemaError(`unknown schemaVersion ${JSON.stringify(raw.schemaVersion)}`)
  }
  const releaseId = nonEmptyString(raw.releaseId, 'releaseId')
  const desktopVersion = nonEmptyString(raw.desktopVersion, 'desktopVersion')
  const sourceCommit = patternString(raw.sourceCommit, 'sourceCommit', GIT_COMMIT_PATTERN)

  const dsh = parseDshFacts(raw.dsh)
  const platform = literalString(raw.platform, 'platform', SUPPORTED_PLATFORMS)
  const arch = literalString(raw.arch, 'arch', SUPPORTED_ARCHES)
  const hostControl = parseHostControl(raw.hostControl)
  const profileSchemaVersion = positiveSafeInt(raw.profileSchemaVersion, 'profileSchemaVersion')
  const pluginApi = parsePluginApi(raw.pluginApi, dsh.npmVersion)
  const formats = parseFormats(raw.formats)
  const dataEpoch = safeInt(raw.dataEpoch, 'dataEpoch')
  const supportedDataEpochs = parseSupportedDataEpochs(raw.supportedDataEpochs, dataEpoch)
  const dependencyClosureSha256 = patternString(
    raw.dependencyClosureSha256,
    'dependencyClosureSha256',
    SHA256_PATTERN,
  )
  const patchManifestSha256 = patternString(
    raw.patchManifestSha256,
    'patchManifestSha256',
    SHA256_PATTERN,
  )

  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId,
    desktopVersion,
    sourceCommit,
    dsh,
    platform,
    arch,
    hostControl,
    profileSchemaVersion,
    pluginApi,
    formats,
    dataEpoch,
    supportedDataEpochs,
    dependencyClosureSha256,
    patchManifestSha256,
  } as const satisfies ReleaseManifest
}

function parseDshFacts(value: unknown): ReleaseManifest['dsh'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestSchemaError('dsh facts must be an object')
  }
  const raw = value as Record<string, unknown>
  const tag = nonEmptyString(raw.tag, 'dsh.tag')
  const commit = patternString(raw.commit, 'dsh.commit', GIT_COMMIT_PATTERN)
  const npmVersion = nonEmptyString(raw.npmVersion, 'dsh.npmVersion')
  return { tag, commit, npmVersion }
}

function parseHostControl(value: unknown): ReleaseManifest['hostControl'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestSchemaError('hostControl must be an object')
  }
  const raw = value as Record<string, unknown>
  return {
    major: nonNegativeSafeInt(raw.major, 'hostControl.major'),
    minor: nonNegativeSafeInt(raw.minor, 'hostControl.minor'),
  }
}

/**
 * One DSH version axis: the plugin API scope is pinned to the exact DSH
 * baseline (verified-exact-baseline strategy), so a pluginApi.dshVersion that
 * diverges from the DSH npm version is a mixed baseline and refused.
 */
function parsePluginApi(value: unknown, dshNpmVersion: string): ReleaseManifest['pluginApi'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestSchemaError('pluginApi must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.strategy !== 'verified-exact-baseline') {
    throw new ManifestSchemaError(`unsupported pluginApi strategy ${JSON.stringify(raw.strategy)}`)
  }
  const dshVersion = nonEmptyString(raw.dshVersion, 'pluginApi.dshVersion')
  if (dshVersion !== dshNpmVersion) {
    throw new ManifestSchemaError(
      `mixed DSH baseline: pluginApi.dshVersion ${dshVersion} != dsh.npmVersion ${dshNpmVersion}`,
    )
  }
  const singletons = stringArray(raw.singletonPackages, 'pluginApi.singletonPackages')
  if (singletons.length === 0) {
    throw new ManifestSchemaError('pluginApi.singletonPackages must not be empty')
  }
  return { strategy: 'verified-exact-baseline', dshVersion, singletonPackages: singletons }
}

function parseFormats(value: unknown): readonly FormatRule[] {
  // An empty formats list is the state since Deskwork dropped cross-product
  // format admission: the marker's schemaVersion and data epoch are the only
  // admission facts, so no per-format rules are declared or verified.
  if (!Array.isArray(value)) {
    throw new ManifestSchemaError('formats must be an array')
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ManifestSchemaError(`formats[${index}] must be an object`)
    }
    const raw = entry as Record<string, unknown>
    const provider = nonEmptyString(raw.provider, `formats[${index}].provider`)
    const providerVersion = nonEmptyString(raw.providerVersion, `formats[${index}].providerVersion`)
    const formatId = nonEmptyString(raw.formatId, `formats[${index}].formatId`)
    const readable = stringArray(raw.readable, `formats[${index}].readable`)
    if (readable.length === 0) {
      throw new ManifestSchemaError(`formats[${index}].readable must not be empty`)
    }
    const writable = nonEmptyString(raw.writable, `formats[${index}].writable`)
    if (!readable.includes(writable)) {
      throw new ManifestSchemaError(
        `formats[${index}] (${formatId}) declares writable ${writable} it does not read`,
      )
    }
    const evidence = stringArray(raw.evidence, `formats[${index}].evidence`)
    if (evidence.length === 0) {
      throw new ManifestSchemaError(`formats[${index}].evidence must not be empty`)
    }
    return { provider, providerVersion, formatId, readable, writable, evidence } as const
  })
}

function parseSupportedDataEpochs(value: unknown, dataEpoch: number): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ManifestSchemaError('supportedDataEpochs must be a non-empty array')
  }
  const epochs = value.map((entry, index) => safeInt(entry, `supportedDataEpochs[${index}]`))
  for (let index = 1; index < epochs.length; index += 1) {
    if (epochs[index]! <= epochs[index - 1]!) {
      throw new ManifestSchemaError('supportedDataEpochs must be strictly ascending and unique')
    }
  }
  if (!epochs.includes(dataEpoch)) {
    throw new ManifestSchemaError(
      `supportedDataEpochs must contain the release dataEpoch ${dataEpoch}`,
    )
  }
  // The release's own epoch is the NEWEST it can understand: a manifest
  // listing a higher epoch than dataEpoch would admit that epoch's homes and
  // then stamp the marker back down to dataEpoch — a silent downgrade write.
  if (epochs[epochs.length - 1] !== dataEpoch) {
    throw new ManifestSchemaError(
      `dataEpoch ${dataEpoch} must be the newest supportedDataEpoch (newest is ${epochs[epochs.length - 1]})`,
    )
  }
  return epochs
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ManifestSchemaError(`${field} must be a non-empty string`)
  }
  return value
}

function patternString(value: unknown, field: string, pattern: RegExp): string {
  const text = nonEmptyString(value, field)
  if (!pattern.test(text)) {
    throw new ManifestSchemaError(`${field} does not match the required shape`)
  }
  return text
}

function literalString<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const text = nonEmptyString(value, field)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new ManifestSchemaError(
      `${field} ${text} is not supported (allowed: ${allowed.join(', ')})`,
    )
  }
  return text as T
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ManifestSchemaError(`${field} must be an array of strings`)
  }
  return value.map((entry, index) => nonEmptyString(entry, `${field}[${index}]`))
}

function safeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ManifestSchemaError(`${field} must be a safe integer`)
  }
  return value
}

function positiveSafeInt(value: unknown, field: string): number {
  const number = safeInt(value, field)
  if (number <= 0) {
    throw new ManifestSchemaError(`${field} must be positive`)
  }
  return number
}

function nonNegativeSafeInt(value: unknown, field: string): number {
  const number = safeInt(value, field)
  if (number < 0) {
    throw new ManifestSchemaError(`${field} must not be negative`)
  }
  return number
}
