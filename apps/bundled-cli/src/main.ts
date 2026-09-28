import { fork, type Serializable } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  LeaseError,
  resolveDesktopHome,
  type GuardLock,
  type HomeLease,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'
import { PRODUCT } from '@dsh-desktop/product-config'
import { loadReleaseManifest, runHomeCompatibilityChain } from '@dsh-desktop/release-compatibility'

import { runDoctorUnlock } from './doctor.js'
import { releaseManifestInput, resolveCliRuntime, type CliRuntimePaths } from './runtime-paths.js'

const childModule = fileURLToPath(new URL('./cli-child.js', import.meta.url))

const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGKILL: 137,
  SIGTERM: 143,
}

export type CliInvocationPlan =
  | Readonly<{ kind: 'doctor-unlock' }>
  | Readonly<{ kind: 'passthrough'; profile: string | undefined }>

/**
 * Decide what the wrapper owns. Only the exact `doctor --unlock` argv is
 * intercepted; everything else is forwarded to the official CLI verbatim.
 * The profile scan mirrors the upstream launcher grammar: `web` is an alias
 * for `--profile web`, `plugin` requires `--profile`, and root launcher
 * flags come before the first inner argument.
 */
/**
 * Launcher flags that consume the NEXT token as their value, per the pinned
 * upstream dsh rc.1 grammar (`--profile <name>`, `--patch <path>`; both also
 * accept `--flag=value`). Everything else launcher-side is boolean
 * (--dump-config, --dump-default-config); a value flag without its value is
 * upstream's own error. The scan stops at the first positional or `--`,
 * exactly where upstream stops parsing launcher flags — misreading this
 * order would route a write-mode invocation through the lease-less branch.
 */
const VALUE_LAUNCHER_FLAGS = new Set(['--profile', '--patch'])

function scanLauncherProfile(argv: readonly string[]): string | undefined {
  let profile: string | undefined
  let expectingProfileValue = false
  let consumingValue = false
  for (const token of argv) {
    if (consumingValue) {
      consumingValue = false
      if (expectingProfileValue) profile = token
      expectingProfileValue = false
      continue
    }
    if (token === '--') break
    if (VALUE_LAUNCHER_FLAGS.has(token)) {
      consumingValue = true
      expectingProfileValue = token === '--profile'
      continue
    }
    if (token.startsWith('--profile=')) {
      profile = token.slice('--profile='.length)
      continue
    }
    if (token.startsWith('-')) continue
    // First positional token starts the inner app arguments; launcher
    // flags cannot appear after it (upstream parses them the same way).
    break
  }
  // `--profile` with no value at all: never attribute a lease on a
  // half-parsed invocation — upstream reports the error either way.
  if (expectingProfileValue) profile = undefined
  return profile
}

/**
 * The `plugin` subcommand grammar differs from the root launcher: bundle
 * names are positionals that legitimately precede `--profile`, and the
 * upstream Commander accepts the flag wherever it appears. Stopping at the
 * first positional here (as the root scan does) would route
 * `plugin add <bundle> --profile <name>` through the lease-less branch
 * while upstream still writes that profile.
 */
function scanPluginProfile(argv: readonly string[]): string | undefined {
  let profile: string | undefined
  let expectingProfileValue = false
  for (const token of argv) {
    if (expectingProfileValue) {
      expectingProfileValue = false
      profile = token
      continue
    }
    if (token === '--') break
    if (token === '--profile') {
      expectingProfileValue = true
      continue
    }
    if (token.startsWith('--profile=')) {
      profile = token.slice('--profile='.length)
    }
    // Any other token — the verb, bundle names, or other options — does
    // not stop the scan.
  }
  // A dangling `--profile` with no value never attributes a lease.
  if (expectingProfileValue) profile = undefined
  return profile
}

export function planCliInvocation(argv: readonly string[]): CliInvocationPlan {
  if (argv.length === 2 && argv[0] === 'doctor' && argv[1] === '--unlock') {
    return { kind: 'doctor-unlock' }
  }
  let profile: string | undefined
  if (argv[0] === 'web') {
    profile = 'web'
  } else if (argv[0] === 'plugin') {
    profile = scanPluginProfile(argv.slice(1))
  } else {
    profile = scanLauncherProfile(argv)
  }
  // An empty profile name is upstream's own error to report, not ours.
  if (profile === '') profile = undefined
  return { kind: 'passthrough', profile }
}

export interface CliChildHandle {
  readonly pid: number
  send(message: unknown): void
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  kill(signal?: NodeJS.Signals): void
}

/**
 * Keeps the single-writer guarantee true while the authorized CLI child
 * runs: the lease gates ADMISSION, not the child's own writes, so a lock
 * removed underneath it (e.g. a frozen older artifact's doctor misreading
 * the new identity format) would otherwise let a second entrant start
 * writing the same home. Two consecutive non-contention failures kill the
 * child; guard contention never counts.
 */
export function startLeaseWatchdog(
  lease: HomeLease,
  child: CliChildHandle,
  stderr: Pick<NodeJS.WriteStream, 'write'>,
  intervalMs = 2_000,
): { stop(): void } {
  let failures = 0
  let stopped = false
  let checking = false
  const timer = setInterval(() => {
    void (async () => {
      if (stopped || checking) return
      checking = true
      try {
        await lease.assertHeld()
        if (stopped) return
        failures = 0
      } catch (error) {
        if (stopped) return
        const code = (error as { code?: string }).code ?? 'unknown error'
        if (code === 'GUARD_BUSY' || code === 'HOME_BUSY') return
        failures += 1
        if (failures < 2) return
        stopped = true
        clearInterval(timer)
        stderr.write(
          `dsh-native: home lease lost while the CLI was running (${code}): killing the child to preserve the single-writer guarantee\n`,
        )
        child.kill('SIGKILL')
      } finally {
        checking = false
      }
    })()
  }, intervalMs)
  timer.unref?.()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

export type SpawnCliChild = (
  input: Readonly<{
    argv: readonly string[]
    env: Record<string, string>
  }>,
) => CliChildHandle

function forkCliChild(
  input: Readonly<{ argv: readonly string[]; env: Record<string, string> }>,
): CliChildHandle {
  // A detached fork puts the child (and every process it spawns) into the
  // child's own process group, so the wrapper can observe and reap the whole
  // write-home tree, not just the direct child.
  const child = fork(childModule, [], {
    env: input.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    detached: true,
  })
  if (child.pid === undefined) throw new Error('forked CLI child has no PID')
  const pgid = child.pid
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const forward = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, signal)
    } catch {
      /* the group is already gone; nothing to forward to */
    }
  }
  const handlers: [NodeJS.Signals, () => void][] = [
    ['SIGINT', () => forward('SIGINT')],
    ['SIGTERM', () => forward('SIGTERM')],
    ['SIGHUP', () => forward('SIGHUP')],
  ]
  for (const [signal, handler] of handlers) process.on(signal, handler)
  // Stop forwarding once the child is gone so repeated invocations never
  // accumulate handlers or signal dead process groups.
  void exited.then(() => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  })
  return {
    pid: child.pid,
    send: (message) => child.send(message as Serializable),
    exited,
    kill: (signal = 'SIGTERM') => {
      try {
        process.kill(-pgid, signal)
      } catch {
        /* the group is already gone */
      }
    },
  }
}

export type HomeAdmissionOutcome =
  | 'allow'
  | 'unknown-schema'
  | 'unsupported-data'
  | 'unknown-format'
  | 'unreadable-format'
  | 'migration-required'

const ADMISSION_REFUSALS: Record<Exclude<HomeAdmissionOutcome, 'allow'>, string> = {
  'unknown-schema':
    'dsh-native: this home has an unknown compatibility marker; refusing to start\n',
  'unsupported-data':
    'dsh-native: this home holds data from a newer release; use the release that wrote it\n',
  'unknown-format':
    'dsh-native: this home holds data this release cannot classify; refusing to start\n',
  'unreadable-format':
    'dsh-native: this home holds data in a format this release cannot read; use the release that wrote it\n',
  'migration-required':
    'dsh-native: this home needs a data migration this release does not perform; keeping the data untouched\n',
}

export type RunBundledCliOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>
  osHome?: string
  cwd?: string
  probe?: ProcessProbe
  guard?: GuardLock
  spawnChild?: SpawnCliChild
  /** Lease-watchdog interval while an authorized child runs (tests shrink it). */
  watchdogIntervalMs?: number
  appVersion?: string
  stderr?: NodeJS.WritableStream
  /**
   * Home compatibility chain (M4), run after the lease is acquired and before
   * any write-home child is spawned. Injectable for tests; the default runs
   * marker parse → read-only inspection → preflight → write-epoch
   * reservation fail-closed.
   */
  admitHome?: (home: string, lease?: HomeLease) => Promise<HomeAdmissionOutcome>
  /** Installed-runtime override (`resolvePackagedCliRuntime`); development resolves from the repository. */
  runtime?: CliRuntimePaths
  /** Test hooks for the descendant process-group checks. */
  groupAlive?: (pgid: number) => boolean
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void
  descendantGraceMs?: number
  descendantEscalationMs?: number
}>

/** Exit code for a home this release refuses to touch. */
const EXIT_HOME_INCOMPATIBLE = 5

async function defaultAdmitHome(home: string, lease?: HomeLease): Promise<HomeAdmissionOutcome> {
  try {
    return await runHomeCompatibilityChain({
      home,
      release: loadReleaseManifest(releaseManifestInput()),
      ...(lease !== undefined ? { lease } : {}),
      // The lease-less passthrough never reserves an epoch: it takes no
      // lease precisely because nothing provably writes.
      reserve: lease !== undefined,
    })
  } catch {
    // Unreadable, symlinked or corrupt markers are all fail-closed refusals.
    return 'unknown-schema'
  }
}

function defaultGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // ESRCH means the group is gone; anything else (EPERM, ...) means the
    // group exists but cannot be probed — treat it as alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function defaultKillGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    /* the group may already be gone */
  }
}

/**
 * Wait for the child's whole process group — including any write-home
 * descendants — to disappear after the direct child exits. Stragglers get a
 * bounded grace period, then TERM→KILL escalation; a group that cannot be
 * proven dead keeps the lease.
 */
async function waitForDescendants(pgid: number, options: RunBundledCliOptions): Promise<boolean> {
  const groupAlive = options.groupAlive ?? defaultGroupAlive
  const killGroup = options.killGroup ?? defaultKillGroup
  const graceMs = options.descendantGraceMs ?? 10_000
  const escalationMs = options.descendantEscalationMs ?? 2_000
  if (!groupAlive(pgid)) return true
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    await sleep(Math.min(100, graceMs))
    if (!groupAlive(pgid)) return true
  }
  killGroup(pgid, 'SIGTERM')
  for (let waited = 0; waited < escalationMs; waited += Math.min(100, escalationMs)) {
    await sleep(Math.min(100, escalationMs))
    if (!groupAlive(pgid)) return true
  }
  killGroup(pgid, 'SIGKILL')
  for (let waited = 0; waited < escalationMs; waited += Math.min(100, escalationMs)) {
    await sleep(Math.min(100, escalationMs))
    if (!groupAlive(pgid)) return true
  }
  return false
}

function childEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  runtime: CliRuntimePaths | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  result.DSH_HOME = home
  if (runtime !== undefined) {
    // Packaged mode: the official CLI spawns `pnpm`/`node` by name (plugin
    // management); resolve them to the staged runtime instead of whatever the
    // ambient PATH provides (there may be no system Node/pnpm at all).
    const stagingRoot = path.resolve(path.dirname(runtime.nodeExecutable), '..', '..')
    const binDirectories = [path.join(stagingRoot, 'bin'), path.dirname(runtime.nodeExecutable)]
    result.PATH = `${binDirectories.join(path.delimiter)}${path.delimiter}${result.PATH ?? '/usr/bin:/bin'}`
  }
  return result
}

function exitCodeOf(exit: { code: number | null; signal: string | null }): number {
  if (exit.code !== null) return exit.code
  if (exit.signal !== null) return SIGNAL_EXIT_CODES[exit.signal] ?? 1
  return 1
}

/**
 * Run one `dsh-native` invocation. The wrapper holds the whole-home lease for
 * the resolved profile before the official CLI child imports its entry; the
 * child's OS identity is registered on the lease before boot authorization.
 */
export async function runBundledCli(
  argv: readonly string[],
  options: RunBundledCliOptions = {},
): Promise<number> {
  const stderr = options.stderr ?? process.stderr
  const env = options.env ?? process.env
  const osHome = options.osHome ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const spawnChild = options.spawnChild ?? forkCliChild
  const home = resolveDesktopHome({ env, osHome, cwd })

  const plan = planCliInvocation(argv)
  // Resolved before every branch: doctor needs the SAME packaged layout the
  // lease paths use, or its stale-lock scan cannot see the installed app.
  const runtime = options.runtime ?? resolveCliRuntime(env)
  if (plan.kind === 'doctor-unlock') {
    return runDoctorUnlock({
      home,
      runtime,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.guard === undefined ? {} : { guard: options.guard }),
      stderr,
    })
  }
  const probe =
    options.probe ??
    createNativeProcessProbe({
      helperPath: runtime.leaseHelper,
      entryExecutables: runtime.desktopEntryExecutables,
      excludePids: [process.pid],
    })

  if (plan.profile === undefined) {
    // Profile-less passthrough still admits the home: it takes no lease
    // (nothing provably writes), but a release must never operate on a home
    // it refuses — admission is read-only and cheap. doctor stays exempt.
    const admission = await (options.admitHome ?? defaultAdmitHome)(home)
    if (admission !== 'allow') {
      stderr.write(ADMISSION_REFUSALS[admission])
      return EXIT_HOME_INCOMPATIBLE
    }
    const child = spawnChild({ argv, env: childEnvironment(env, home, options.runtime) })
    child.send({ kind: 'dsh-native-authorized', argv, dshBin: runtime.dshBin })
    const exit = await child.exited
    const descendantsGone = await waitForDescendants(child.pid, options)
    if (!descendantsGone) {
      stderr.write(
        'dsh-native: cannot prove the CLI process group exited; inspect the leftover processes\n',
      )
      return 4
    }
    return exitCodeOf(exit)
  }

  let lease
  try {
    lease = await acquireHomeLease({
      home,
      entrypoint: 'bundled-cli',
      profile: plan.profile,
      appVersion: options.appVersion ?? PRODUCT.cliName,
      probe,
      ...(options.guard === undefined ? {} : { guard: options.guard }),
    })
  } catch (error) {
    if (error instanceof LeaseError) {
      stderr.write(
        `dsh-native: cannot use this home (${error.code}): ${error.message}\n` +
          (error.ownerSummary !== undefined ? `dsh-native: owner ${error.ownerSummary}\n` : '') +
          'dsh-native: entries of a custom home must use the same DESKWORK_HOME; run dsh-native doctor --unlock for stale locks\n',
      )
      return 3
    }
    throw error
  }

  let leaseKeptForDiagnosis = false
  try {
    // Home compatibility chain: after the lease, before any write-home child
    // exists. A refusal exits without a single home write.
    const admission = await (options.admitHome ?? defaultAdmitHome)(home, lease)
    if (admission !== 'allow') {
      stderr.write(ADMISSION_REFUSALS[admission])
      return EXIT_HOME_INCOMPATIBLE
    }
    await lease.beforeSpawn(plan.profile)
    let child: CliChildHandle | undefined
    let authorized = false
    try {
      child = spawnChild({ argv, env: childEnvironment(env, home, options.runtime) })
      const identity = await probe.identify(child.pid)
      await lease.attachHost(identity)
      child.send({ kind: 'dsh-native-authorized', argv, dshBin: runtime.dshBin })
      authorized = true
      const watchdog = startLeaseWatchdog(lease, child, stderr, options.watchdogIntervalMs)
      let exit: { code: number | null; signal: string | null }
      let descendantsGone: boolean
      try {
        exit = await child.exited
        // The direct child exiting does NOT mean the home is idle: pnpm and
        // anything the official CLI spawned may still be writing. The
        // watchdog stays armed through the descendant wait.
        descendantsGone = await waitForDescendants(child.pid, options)
      } finally {
        watchdog.stop()
      }
      if (!descendantsGone) {
        leaseKeptForDiagnosis = true
        stderr.write(
          'dsh-native: cannot prove the CLI process group exited; keeping the home lease\n' +
            'dsh-native: run dsh-native doctor --unlock once the processes are gone\n',
        )
        return 4
      }
      await lease.confirmHostExited()
      return exitCodeOf(exit)
    } catch (error) {
      // A forked child that never received authorization must be provably
      // reaped before the lease registration is cleared and released.
      if (child !== undefined && !authorized) {
        const reaped = await reapUnauthorizedChild(child)
        if (!reaped) {
          // The child may still be alive and must never be trusted to stay
          // idle: keep the lease for doctor diagnostics instead of releasing.
          leaseKeptForDiagnosis = true
          stderr.write(
            'dsh-native: cannot prove the unauthorized CLI child exited; keeping the home lease\n' +
              'dsh-native: run dsh-native doctor --unlock once the process is gone\n',
          )
          return 4
        }
      }
      await lease.confirmHostExited().catch(() => undefined)
      throw error
    }
  } finally {
    if (!leaseKeptForDiagnosis) {
      await lease.release().catch((error: unknown) => {
        stderr.write(
          `dsh-native: keeping the home lease after exit: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      })
    }
  }
}

/** Returns whether the child provably exited within the escalation budget. */
async function reapUnauthorizedChild(child: CliChildHandle): Promise<boolean> {
  let exited = false
  void child.exited.then(
    () => {
      exited = true
    },
    () => undefined,
  )
  child.kill('SIGTERM')
  await Promise.race([child.exited.catch(() => undefined), sleep(2_000)])
  if (!exited) {
    child.kill('SIGKILL')
    await Promise.race([child.exited.catch(() => undefined), sleep(500)])
  }
  return exited
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
