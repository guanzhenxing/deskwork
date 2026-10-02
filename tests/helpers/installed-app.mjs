import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearTimeout as cancelTimer, setTimeout as sleepTimer } from 'node:timers'

import { waitUntilDead } from './desktop-driver.mjs'

/**
 * Emergency teardown registry: every launched process group and temporary
 * install tree registers its cleanup here. Signal handlers (and normal
 * process exit) drain the registry, so an interrupted smoke run never leaves
 * installed-app processes, temp install directories, or DMG mounts behind on
 * the user's machine.
 */
/**
 * The authenticated surface URL never travels over stdout (captured logs);
 * the app writes it to <userData>/surface-url and the ui-ready report points
 * here. Attach it to the matched report in memory for the driver's own use —
 * drivers may hold it, logs may not.
 */
async function attachSurfaceUrl(report, userData) {
  if (report?.kind !== 'ui-ready' || report.surfaceUrlFile !== 'surface-url') return report
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const raw = (await readFile(path.join(userData, 'surface-url'), 'utf8')).trim()
      if (raw !== '') return { ...report, surfaceUrl: raw }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (Date.now() > deadline) {
      throw new Error('ui-ready pointed at the surface URL file but it never appeared')
    }
    await new Promise((resolve) => sleepTimer(resolve, 100))
  }
}

const liveCleanups = new Set()

/**
 * Drain every registered cleanup. Cleanups may be sync or async; one that
 * FAILS (by throwing or rejecting — registered cleanups must REPORT failure,
 * not swallow it) stays registered so a later drain retries it; successful
 * ones are forgotten. Re-entrancy is safe — the drain iterates a snapshot.
 */
export async function emergencyCleanup() {
  const pending = [...liveCleanups]
  for (const cleanup of pending) liveCleanups.delete(cleanup)
  for (const cleanup of pending) {
    try {
      // await on a sync (undefined-returning) cleanup is fine; the try/catch
      // is what matters — one failed cleanup must never abort the drain.
      await cleanup()
    } catch {
      liveCleanups.add(cleanup)
    }
  }
}

/**
 * Bounded, self-driving drain for paths that OWN the process exit: a failed
 * cleanup is retried (Node does NOT re-emit beforeExit when a handler only
 * schedules microtasks, so each activation drives its own retries with a
 * real timer keeping the loop alive). The round budget is SHARED across the
 * whole process lifetime — signal drains and beforeExit flushes draw from
 * the same at-most-three rounds, never three each.
 */
let drainRoundsUsed = 0
let drainInFlight
/**
 * Concurrent signals must SHARE one drain: the first drain temporarily
 * empties the registry while awaiting its cleanups, so a second signal
 * entering here would see "nothing to do", exit early, and process.exit
 * mid-cleanup of the first. Every caller awaits the same promise.
 */
export function drainWithRetries(maxTotalRounds = 3) {
  if (drainInFlight !== undefined) return drainInFlight
  drainInFlight = (async () => {
    for (;;) {
      if (liveCleanups.size === 0 || drainRoundsUsed >= maxTotalRounds) return
      drainRoundsUsed += 1
      await emergencyCleanup()
      if (liveCleanups.size === 0 || drainRoundsUsed >= maxTotalRounds) return
      await new Promise((resolve) => sleepTimer(resolve, 50))
    }
  })().finally(() => {
    drainInFlight = undefined
  })
  return drainInFlight
}

/** Install the real smoke/rehearsal cancellation behavior once per process. */
export function installTerminationHandlers() {
  let exiting = false
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (exiting) return
      exiting = true
      const exitCode = signal === 'SIGINT' ? 130 : 143
      void drainWithRetries().finally(() => process.exit(exitCode))
    })
  }
}

// Normal completion must also flush leftovers (e.g. a DMG mount whose
// transient detach failed mid-run). Registered unconditionally; other
// listeners on this event must not disable it.
process.on('beforeExit', () => {
  void drainWithRetries()
})

function registerCleanup(cleanup) {
  liveCleanups.add(cleanup)
  return () => liveCleanups.delete(cleanup)
}

/**
 * Register a cleanup for the emergency drain (SIGINT/SIGTERM handlers and
 * abnormal exits). Cleanups may be sync or async; a failing one never stops
 * the rest of the drain. Returns an unregister function.
 */
export function registerEmergencyCleanup(cleanup) {
  return registerCleanup(cleanup)
}

/**
 * Install the packaged app the way a user would, minus /Applications and
 * Gatekeeper: mount the candidate DMG read-only with hdiutil, copy the .app
 * into a throwaway install directory, unmount, and hand back the copy. The
 * mount is always detached, including on failure paths.
 */
export async function installFromDmg(dmgPath, productName) {
  // Choose the mount point before attaching. hdiutil's presentation output
  // is deliberately not part of the cleanup protocol: even malformed plist
  // output leaves us with a deterministic target to detach.
  const mountPoint = await mkdtemp(path.join(tmpdir(), 'dsh-dmg-mount-'))
  // The mount must be reachable from the emergency registry BEFORE any
  // further await (mkdtemp included): a signal or failure in that window
  // would otherwise leave the DMG mounted. The registered cleanup must
  // REPORT failure (throw) — a swallowed error would make the drain treat
  // the detach as done and never retry it. The finally path uses the same
  // cleanup through a quiet probe and only unregisters on success; a failed
  // detach KEEPS the registration for a later drain.
  const detachMount = async () => {
    execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
    await rm(mountPoint, { recursive: true, force: true })
  }
  let unregisterMount
  let mounted = false
  let installDirectory
  try {
    execFileSync(
      'hdiutil',
      ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath],
      {
        stdio: 'ignore',
      },
    )
    mounted = true
    unregisterMount = registerCleanup(detachMount)
    installDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-installed-app-'))
    const appBundle = path.join(mountPoint, `${productName}.app`)
    const identity = await lstat(appBundle)
    if (!identity.isDirectory()) throw new Error(`${appBundle} is not an app bundle`)
    // ditto is Apple's tool for copying .app bundles: it preserves the
    // relative symlink trees (Electron Framework, the pnpm closures) AND the
    // code-signature resources — a plain cp leaves the copied bundle with an
    // invalid signature, which the kernel then kills at launch.
    execFileSync('/usr/bin/ditto', [appBundle, path.join(installDirectory, `${productName}.app`)])
  } catch (error) {
    if (installDirectory !== undefined) {
      await rm(installDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
    throw error
  } finally {
    let detached = false
    if (mounted) {
      try {
        await detachMount()
        detached = true
      } catch {
        /* busy or already gone — the registration stays for a later drain */
      }
    } else {
      await rm(mountPoint, { recursive: true, force: true })
    }
    if (detached) unregisterMount?.()
  }
  const appPath = path.join(installDirectory, `${productName}.app`)
  const unregister = registerCleanup(() => rm(installDirectory, { recursive: true, force: true }))
  return {
    installDirectory,
    appPath,
    executable: path.join(appPath, 'Contents', 'MacOS', productName),
    async dispose() {
      unregister()
      const identity = await lstat(installDirectory)
      if (
        identity.isSymbolicLink() ||
        !identity.isDirectory() ||
        path.dirname(await realpath(installDirectory)) !== (await realpath(tmpdir())) ||
        !path.basename(installDirectory).startsWith('dsh-installed-app-')
      ) {
        throw new Error(`refusing to clean an unexpected install directory: ${installDirectory}`)
      }
      await rm(installDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

/**
 * Launch the installed app executable in a driver-owned smoke mode with a
 * scrubbed environment (no NODE_PATH/NODE_OPTIONS, minimal PATH, neutral cwd
 * outside the repository). Resolves the captured smoke reports when the app
 * exits; rejects on non-zero exits or a 'failed' report.
 */
export async function runInstalledApp(input) {
  const {
    executable,
    mode,
    profileName,
    userData,
    home,
    action,
    cwd,
    timeoutMs = 240_000,
    graceMs = 90_000,
  } = input
  const reports = []
  const child = spawn(executable, [], {
    cwd,
    detached: true,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME,
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      DSH_DESKTOP_SMOKE: mode,
      ...(profileName === undefined ? {} : { DSH_DESKTOP_SMOKE_PROFILE: profileName }),
      DSH_DESKTOP_M0_USER_DATA: userData,
      ...(home === undefined ? {} : { DESKWORK_HOME: home }),
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const unregisterGroup = registerCleanup(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    return Promise.resolve()
  })
  const consumeLines = (stream, onLine) => {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim() !== '') onLine(line)
      }
    })
  }
  consumeLines(child.stdout, (line) => {
    if (line.startsWith('DSH_DESKTOP_SMOKE ')) {
      reports.push(JSON.parse(line.slice('DSH_DESKTOP_SMOKE '.length)))
    } else {
      process.stdout.write(`${line}\n`)
    }
  })
  consumeLines(child.stderr, (line) => process.stderr.write(`${line}\n`))
  const timeout = sleepTimer(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  timeout.unref?.()
  try {
    if (action !== undefined) {
      await action({
        reports,
        async waitFor(predicate, label, waitMs = 180_000) {
          const deadline = Date.now() + waitMs
          for (;;) {
            const found = reports.find(predicate)
            if (found !== undefined) return await attachSurfaceUrl(found, userData)
            if (Date.now() > deadline) {
              throw new Error(`timed out waiting for ${label ?? 'an app report'}`)
            }
            await new Promise((resolve) => sleepTimer(resolve, 200))
          }
        },
      })
    }
  } finally {
    cancelTimer(timeout)
    // Driver-owned modes quit through their own before-quit chain; give that
    // chain a real grace window before escalating to signals (a SIGTERM mid-
    // quit would report the run as a signal kill and hide the real exit code).
    await Promise.race([exited, new Promise((resolve) => sleepTimer(resolve, graceMs))])
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  exited.then(
    () => unregisterGroup(),
    () => unregisterGroup(),
  )
  const exit = await Promise.race([
    exited,
    new Promise((resolve) => {
      const killTimer = sleepTimer(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
        resolve({ code: null, signal: 'SIGKILL' })
      }, 30_000)
      killTimer.unref?.()
    }),
  ])
  if (exit.code !== 0) {
    throw new Error(`installed app exited with code ${exit.code} signal ${exit.signal}`)
  }
  // In recovery mode the poisoned boot settles through the recovery chain by
  // design: start() rejects (reported as failed/startup) before the scripted
  // sequence takes over. Only the sequence's own failure flag counts there.
  const failed = reports.find(
    (report) => report.kind === 'failed' && !(mode === 'recovery' && report.stage === 'startup'),
  )
  if (failed !== undefined) {
    throw new Error(`installed app reported failure at ${failed.stage}`)
  }
  for (const report of reports) {
    for (const pid of [report.launcherPid, report.hostPid]) {
      if (Number.isSafeInteger(pid)) await waitUntilDead(pid, 20_000)
    }
  }
  return reports
}
