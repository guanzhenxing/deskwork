import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  createRuntimeResolution,
  loadOptionalPatches,
  loadProfile,
  PluginPackages,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import {
  createEnvelopeWriter,
  HostControlError,
  parseLauncherEnvelope,
  redactDiagnostic,
  type HostIdentity,
  type LauncherToHostMessage,
  type LoopbackSurface,
  type DesktopSurfaceService,
} from '@dsh-desktop/desktop-contracts/host-control'

import { createRuntimeRoot, type RuntimeRoot } from './runtime-root.js'
import { assertBootProfile, type BootMode } from './boot-profile.js'

export interface HostControlTransport {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  close?(): void
}

export type RunDshHostOptions = Readonly<{
  home: string
  profileName: string
  mode: BootMode
  capability: string
  leaseGeneration: string
  hostIdentity: HostIdentity
  transport: HostControlTransport
  installAnchor?: string
  acceptTimeoutMs?: number
}>

export type DshHostHandle = Readonly<{
  disposed: Promise<void>
  dispose(): Promise<void>
}>

/**
 * Marks where in the boot sequence an error was captured. The stage/code pair
 * travels on the fatal envelope so the launcher can classify locally without
 * guessing from message words.
 */
class StagedBootError extends Error {
  readonly stage: string
  readonly code: string
  readonly retryable: boolean

  constructor(stage: string, code: string, retryable: boolean, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'StagedBootError'
    this.stage = stage
    this.code = code
    this.retryable = retryable
  }
}

async function staged<Value>(
  stage: string,
  code: string,
  retryable: boolean,
  operation: () => Promise<Value>,
): Promise<Value> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof StagedBootError) throw error
    throw new StagedBootError(stage, code, retryable, error)
  }
}

const PROFILE_ROOT_CONFIG = `# dsh desktop profile root; compose through bundle and user patch layers.
[]
`
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const DSH_INSTALL_ANCHOR = realpathSync.native(
  createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'),
)

type Deferred<Value> = {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(reason: unknown): void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

export async function runDshHost(options: RunDshHostOptions): Promise<DshHostHandle> {
  const bootProfile = assertBootProfile({ mode: options.mode, profileName: options.profileName })
  if (!bootProfile.ok)
    throw new Error(`dsh-desktop Host boot profile invalid: ${bootProfile.reason}`)
  const safeMode = options.mode === 'safe'
  const writer = createEnvelopeWriter(
    'host-to-launcher',
    options.capability,
    options.leaseGeneration,
  )
  const accepted = deferred<void>()
  const contextReady = deferred<Context | undefined>()
  const disposed = deferred<void>()
  let expectedSequence = 1
  let protocolState: 'awaiting-accept' | 'running' | 'draining' | 'disposed' = 'awaiting-accept'
  let context: Context | undefined
  let disposePromise: Promise<void> | undefined
  let surfaceId: string | undefined
  let runtimeRoot: RuntimeRoot | undefined
  let runtimeResolution: RuntimeResolution | undefined
  let originalDshHome = process.env.DSH_HOME
  const originalCwd = process.cwd()

  const restoreEnvironment = (): void => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
    originalDshHome = undefined
  }

  const isDisposing = (): boolean =>
    (['draining', 'disposed'] as const).some((state) => state === protocolState)

  const cleanupRuntimeRoot = async (): Promise<void> => {
    if (runtimeRoot === undefined) return
    if (process.cwd() === runtimeRoot.dir) process.chdir(originalCwd)
    await runtimeRoot.remove()
    runtimeRoot = undefined
  }

  const disposeHost = (acknowledge: boolean): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    protocolState = 'draining'
    disposePromise = (async () => {
      const activeContext = context ?? (await contextReady.promise)
      try {
        await activeContext?.fiber.dispose()
        await cleanupRuntimeRoot()
      } finally {
        protocolState = 'disposed'
        restoreEnvironment()
      }
      if (acknowledge) {
        options.transport.postMessage(writer.next({ kind: 'dispose-ack', outcome: 'disposed' }))
      }
      disposed.resolve()
    })()
    return disposePromise
  }

  const failProtocol = (error: unknown): void => {
    const failure =
      error instanceof HostControlError
        ? error
        : new HostControlError('INVALID_ENVELOPE', 'Launcher message was rejected')
    if (protocolState === 'awaiting-accept') accepted.reject(failure)
    options.transport.postMessage(
      writer.next({
        kind: 'fatal',
        stage: 'host-control',
        code: failure.code,
        summary: 'Host-control input was rejected',
        retryable: false,
      }),
    )
    void disposeHost(false)
  }

  const handleLauncherMessage = (input: unknown): void => {
    try {
      const envelope = parseLauncherEnvelope(input)
      if (!constantTimeEqual(envelope.capability, options.capability)) {
        throw new HostControlError('INVALID_CAPABILITY', 'Launcher capability does not match')
      }
      if (!constantTimeEqual(envelope.leaseGeneration, options.leaseGeneration)) {
        throw new HostControlError('LEASE_MISMATCH', 'Launcher lease generation does not match')
      }
      if (envelope.sequence !== expectedSequence) {
        throw new HostControlError('INVALID_ENVELOPE', 'Launcher sequence is not contiguous')
      }
      expectedSequence += 1
      const message: LauncherToHostMessage = envelope.message
      if (message.kind === 'accept') {
        if (protocolState !== 'awaiting-accept' || message.selectedMinor !== 0) {
          throw new HostControlError('INVALID_TRANSITION', 'Unexpected Host-control accept')
        }
        protocolState = 'running'
        accepted.resolve()
        return
      }
      if (protocolState !== 'running') {
        throw new HostControlError('INVALID_TRANSITION', 'Unexpected Host-control dispose')
      }
      void disposeHost(true)
    } catch (error) {
      failProtocol(error)
    }
  }

  const removeMessageListener = options.transport.onMessage(handleLauncherMessage)
  options.transport.postMessage(
    writer.next({
      kind: 'hello',
      host: options.hostIdentity,
      profile: { name: options.profileName },
      mode: options.mode,
      supportedMinor: { min: 0, max: 0 },
    }),
  )

  const acceptTimer = setTimeout(() => {
    accepted.reject(
      new HostControlError('PROTOCOL_MISMATCH', 'Launcher did not accept Host-control'),
    )
  }, options.acceptTimeoutMs ?? 10_000)

  try {
    await accepted.promise
    clearTimeout(acceptTimer)
    options.transport.postMessage(writer.next({ kind: 'phase', phase: 'booting' }))
    process.env.DSH_HOME = options.home

    const installAnchor = options.installAnchor ?? DSH_INSTALL_ANCHOR
    // Named boot stages, classified at the capture site: runtime resolution
    // (neutral launch root, in-process module interception, bundle
    // projections), profile resolution, home patch parsing, the Cordis boot
    // itself, and surface publication. Attribution no stage can make stays
    // BOOT_FAILED/unknown.
    await staged('resolve-runtime', 'RUNTIME_UNAVAILABLE', true, async () => {
      runtimeRoot = await createRuntimeRoot(options.home)
    })
    if (runtimeRoot === undefined) throw new Error('launch root was not created')
    const launchDir = runtimeRoot.dir
    // Keep the Host cwd inside the neutral launch root so workspace/config
    // discovery never walks up into the launcher's project directory.
    process.chdir(launchDir)
    const profile = await staged('resolve-profile', 'PROFILE_INVALID', false, async () =>
      // Safe mode never even parses the profile-local cordis.patch.yml
      // (userLayer: false): a corrupt or hostile patch must not be able to
      // fail the safe boot, and its layers are never composed anyway.
      loadProfile('dsh-desktop', options.profileName, installAnchor, options.home, {
        userLayer: !safeMode,
      }),
    )
    const rootConfigPath = path.join(launchDir, PROFILE_ROOT_FILENAME)
    await staged('resolve-runtime', 'RUNTIME_UNAVAILABLE', true, async () => {
      // Keep the transient Cordis root outside the named profile while retaining
      // Node's parent-directory lookup through the launch root's node_modules.
      await writeFile(rootConfigPath, PROFILE_ROOT_CONFIG, { mode: 0o600 })
      // Upstream replaced on-disk module-resolution fallbacks with an
      // in-process interception: compute the launch root's resolution here
      // (mirroring the official profile boot) and install it through the
      // PluginPackages service in the boot prepare callback below.
      runtimeResolution = await createRuntimeResolution({
        installAnchor,
        profile: { ...profile, dir: launchDir },
        home: options.home,
      })
      // Upstream projects bundle dependencies but excludes the bundles themselves:
      // they normally already live in profile/node_modules. Our neutral root must
      // also project those selected packages, without touching the source profile.
      for (const [packageName, packageDir] of new Map(
        profile.layers.map((layer) => [layer.packageName, layer.packageDir]),
      )) {
        if (!/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu.test(packageName)) {
          throw new Error('Selected bundle must use a valid package name')
        }
        const link = path.join(launchDir, 'node_modules', packageName)
        await mkdir(path.dirname(link), { recursive: true })
        await symlink(realpathSync.native(packageDir), link, 'dir')
      }
    })
    const homePatches = await staged(
      'load-home-patch',
      'HOME_PATCH_INVALID',
      false,
      async () =>
        loadOptionalPatches('dsh-desktop', path.join(options.home, 'cordis.patch.yml')) ?? [],
    )
    // Safe mode composes only the selected bundles' own patches plus the
    // shared home patch: profile-local patches are user content the safe
    // boot must never execute (the launcher's prepareSafeProfile refuses
    // them, and the runner enforces the same boundary independently).
    const patches = structuredClone(
      safeMode
        ? [...profile.layers.flatMap((layer) => layer.patches), ...homePatches]
        : [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches, ...homePatches],
    )
    const environment = createLaunchEnvironmentSnapshot([
      { source: 'process', values: processEnvironment() },
    ])
    const desktopSurface: DesktopSurfaceService = {
      schedule(surface: LoopbackSurface): void {
        if (surfaceId !== undefined)
          throw new Error('dsh-desktop Host received more than one surface')
        surfaceId = randomUUID()
        options.transport.postMessage(writer.next({ kind: 'phase', phase: 'surface-waiting' }))
        options.transport.postMessage(
          writer.next({
            kind: 'surface',
            surfaceId,
            purpose: safeMode ? 'recovery' : 'normal',
            surface,
          }),
        )
      },
    }

    context = await staged('boot', 'BOOT_FAILED', true, () =>
      boot('dsh-desktop', rootConfigPath, patches, async (hostContext) => {
        context = hostContext
        contextReady.resolve(hostContext)
        hostContext.provide('desktopSurface', desktopSurface)
        hostContext.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        if (runtimeResolution === undefined) throw new Error('runtime resolution was not computed')
        await hostContext.plugin(PluginPackages, { resolution: runtimeResolution })
        provideCmdline(hostContext, {
          args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
          exit: () => void disposeHost(false),
        })
      }),
    )
    const publishedSurfaceId = await staged(
      'publish-surface',
      'SURFACE_MISSING',
      false,
      async () => {
        if (surfaceId === undefined) throw new Error('desktop-plugin did not publish a surface')
        return surfaceId
      },
    )
    options.transport.postMessage(writer.next({ kind: 'ready', surfaceId: publishedSurfaceId }))
    return Object.freeze({
      disposed: disposed.promise.finally(removeMessageListener),
      dispose: () => disposeHost(false),
    })
  } catch (error) {
    clearTimeout(acceptTimer)
    contextReady.resolve(undefined)
    await context?.fiber.dispose()
    await cleanupRuntimeRoot()
    restoreEnvironment()
    const detail = error instanceof Error ? error.message : String(error)
    const summary = redactDiagnostic(detail, {
      capability: options.capability,
      home: options.home,
    }).slice(0, 1024)
    if (!isDisposing()) {
      const stagedDetail =
        error instanceof StagedBootError
          ? { stage: error.stage, code: error.code, retryable: error.retryable }
          : { stage: 'boot', code: 'BOOT_FAILED', retryable: true }
      options.transport.postMessage(
        writer.next({
          kind: 'fatal',
          ...stagedDetail,
          summary: summary === '' ? 'DSH Host boot failed' : summary,
        }),
      )
    }
    removeMessageListener()
    throw error
  }
}
