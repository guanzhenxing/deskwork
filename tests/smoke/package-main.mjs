// M3 artifact-level acceptance: install the packaged DMG candidate into a
// throwaway directory (hdiutil mount → copy → detach, never /Applications,
// no Gatekeeper changes) and run every desktop/data/recovery scenario
// against the installed copy — never the development tree. The app and CLI
// run with scrubbed environments (no NODE_PATH/NODE_OPTIONS, minimal PATH,
// neutral cwd); profile-recovery/safe-mode/admission run through the
// installed runtime closure via the controller driver.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearTimeout as clearSleepTimer, setTimeout as sleepTimer } from 'node:timers'
import { fileURLToPath } from 'node:url'

import {
  installTerminationHandlers,
  installFromDmg,
  runInstalledApp,
  runInstalledCli,
} from '../helpers/installed-app.mjs'
import {
  createSharedHomeFixture,
  createWebApiClient,
  driveOneTurn,
  listSessions,
  waitForTurns,
} from '../helpers/shared-home-driver.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const driverPath = path.join(repositoryRoot, 'tests', 'fixtures', 'installed-controller-driver.mjs')
const PRODUCT_NAME = 'Deskwork'

// An interrupted run (Ctrl-C, CI cancel) must never leave installed-app
// processes, temp install trees, or DMG mounts on the user's machine. The
// Node runtime pin already happened in the thin package.mjs entry, before
// this module was imported.
installTerminationHandlers()

const results = []

async function record(name, run) {
  const startedAt = new Date().toISOString()
  try {
    await run()
    results.push({ name, ok: true, startedAt })
    console.log(`PKG-SMOKE ✓ ${name}`)
  } catch (error) {
    results.push({ name, ok: false, startedAt, error: String(error?.message ?? error) })
    console.error(`PKG-SMOKE ✗ ${name}: ${error?.stack ?? error}`)
  }
}

function apiStatus(url, cookie) {
  const origin = new URL(url).origin
  return globalThis
    .fetch(`${origin}/api/session/list`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'pkg-auth',
        method: 'session/list',
        payload: { args: [{ _request: {} }] },
      }),
    })
    .then(async (response) => {
      await response.arrayBuffer()
      return response.status
    })
}

function cookieOf(response) {
  return response.headers.getSetCookie()[0]?.split(';')[0]
}

async function refuseUnauthorized(status, label) {
  if (status !== 401 && status !== 403) {
    throw new Error(`${label}: expected 401/403, got ${status}`)
  }
}

async function makeControllerHome(label) {
  const userData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-'))
  void label
  const home = path.join(userData, 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  return {
    userData,
    home,
    dispose: () => rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  }
}

async function runControllerScenario(install, scenario) {
  const fixture = await makeControllerHome(scenario)
  try {
    const node = path.join(
      install.appPath,
      'Contents',
      'Resources',
      'runtime-cli',
      'node',
      'bin',
      'node',
    )
    const child = spawn(
      node,
      [driverPath, path.join(install.appPath, 'Contents', 'Resources'), scenario, fixture.home],
      {
        cwd: fixture.userData,
        env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        output += chunk
      })
    }
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
      // A deadlocked installed closure (exactly what this scenario exists to
      // catch) must FAIL the run, not hang the whole package smoke.
      const killTimer = sleepTimer(() => {
        child.kill('SIGKILL')
        reject(new Error(`controller driver ${scenario} timed out after 120s and was killed`))
      }, 120_000)
      killTimer.unref?.()
      child.once('exit', () => clearSleepTimer(killTimer))
    })
    if (exit.code !== 0) {
      throw new Error(`controller driver ${scenario} exited ${exit.code}: ${output.slice(-800)}`)
    }
    if (!output.includes('"ok":true')) {
      throw new Error(`controller driver ${scenario} reported no success: ${output.slice(-400)}`)
    }
  } finally {
    await fixture.dispose()
  }
}

// ── The scenarios ─────────────────────────────────────────────────────────

function dshUiScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('ui')
    try {
      const reports = await runInstalledApp({
        executable: install.executable,
        mode: 'ui',
        userData: fixture.userData,
        cwd: fixture.userData,
      })
      const ready = reports.find((report) => report.kind === 'ui-ready')
      if (ready === undefined) throw new Error('installed app never reached ui-ready')
      if (ready.launcherPid === ready.hostPid)
        throw new Error('Host did not run in its own process')
    } finally {
      await fixture.dispose()
    }
  }
}

function loadingPageScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('loading')
    try {
      const reports = await runInstalledApp({
        executable: install.executable,
        mode: 'loading',
        userData: fixture.userData,
        cwd: fixture.userData,
      })
      const shown = reports.find((report) => report.kind === 'loading-view-visible')
      if (
        typeof shown?.url !== 'string' ||
        !shown.url.endsWith('/recovery/loading-view.html') ||
        shown.visible !== true
      ) {
        throw new Error(`loading view was not visibly loaded: ${JSON.stringify(shown)}`)
      }
      const replaced = reports.find((report) => report.kind === 'loading-view-replaced')
      if (typeof replaced?.url !== 'string' || !replaced.url.startsWith('http://127.0.0.1:')) {
        throw new Error(
          `Host surface did not replace the loading view: ${JSON.stringify(replaced)}`,
        )
      }
      if (reports.indexOf(shown) >= reports.indexOf(replaced)) {
        throw new Error('Host surface replaced the loading view before it was visibly loaded')
      }
    } finally {
      await fixture.dispose()
    }
  }
}

function hostCrashScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('host-crash')
    try {
      const reports = await runInstalledApp({
        executable: install.executable,
        mode: 'host-crash',
        userData: fixture.userData,
        cwd: fixture.userData,
        timeoutMs: 300_000,
      })
      for (const kind of ['host-crash-recovery']) {
        if (!reports.some((report) => report.kind === kind)) {
          throw new Error(`installed app did not report ${kind}`)
        }
      }
    } finally {
      await fixture.dispose()
    }
  }
}

function navigationScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('navigation')
    try {
      await runInstalledApp({
        executable: install.executable,
        mode: 'navigation',
        userData: fixture.userData,
        cwd: fixture.userData,
        async action({ reports, waitFor }) {
          const done = await waitFor(
            (report) => report.kind === 'navigation-probe-done',
            'navigation probes',
          )
          const external = reports
            .filter((report) => report.kind === 'external-opened')
            .map((report) => report.url)
          // Only the window-open path (user-gesture target=_blank links) may
          // hand a URL to the system browser; in-frame navigation is blocked
          // without external handoff.
          const expected = ['https://example.com/popup-approved']
          if (JSON.stringify(external) !== JSON.stringify(expected)) {
            throw new Error(`external handoff mismatch: ${JSON.stringify(external)}`)
          }
          if (external.some((url) => url.includes('main-frame-blocked'))) {
            throw new Error('script-driven navigation reached the system browser')
          }
          if (!done.currentUrl.startsWith('http://127.0.0.1:')) {
            throw new Error(`main frame left the surface: ${done.currentUrl}`)
          }
        },
      })
    } finally {
      await fixture.dispose()
    }
  }
}

function lifecycleScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('lifecycle')
    try {
      await runInstalledApp({
        executable: install.executable,
        mode: 'lifecycle',
        userData: fixture.userData,
        cwd: fixture.userData,
        timeoutMs: 300_000,
        async action({ waitFor }) {
          const closeHidden = await waitFor(
            (report) => report.kind === 'lifecycle' && report.step === 'close-hidden',
            'close-hidden',
          )
          if (closeHidden.visible !== false || closeHidden.destroyed !== false) {
            throw new Error('close-to-tray failed on the installed app')
          }
          for (const step of ['tray-shown', 'dock-activated']) {
            await waitFor((report) => report.kind === 'lifecycle' && report.step === step, step)
          }
          // A duplicate launch of the installed executable focuses the running
          // instance and exits itself. This must run while the app is still
          // alive — after sequence-done it is already quitting.
          const duplicate = await Promise.race([
            spawnDuplicate(install, fixture),
            new Promise((_, reject) =>
              sleepTimer(() => reject(new Error('duplicate launch hung')), 120_000),
            ),
          ])
          if (duplicate.code !== 0) {
            throw new Error(`duplicate instance exited ${duplicate.code} ${duplicate.signal}`)
          }
          await waitFor(
            (report) => report.kind === 'second-instance-focused',
            'second-instance-focused',
          )
          for (const step of ['renderer-reload-verified', 'sequence-done']) {
            await waitFor((report) => report.kind === 'lifecycle' && report.step === step, step)
          }
          await waitFor((report) => report.kind === 'renderer-crashed', 'renderer-crashed')
          await waitFor(
            (report) => report.kind === 'recovery-view' && report.code === 'RENDERER_CRASHED',
            'renderer recovery view',
          )
          // The full quit must release the home lease (same bar as the dev
          // lifecycle smoke and the conversation scenario).
          await waitForLeaseGone(fixture.home)
        },
      })
    } finally {
      await fixture.dispose()
    }
  }
}

function spawnDuplicate(install, fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(install.executable, [], {
      cwd: fixture.userData,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME,
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        DSH_DESKTOP_SMOKE: 'lifecycle',
        DSH_DESKTOP_M0_USER_DATA: fixture.userData,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function authScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('auth')
    try {
      let firstSurfaceUrl
      let firstCookie
      await runInstalledApp({
        executable: install.executable,
        mode: 'auth',
        userData: fixture.userData,
        cwd: fixture.userData,
        async action({ waitFor }) {
          const ready = await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
          firstSurfaceUrl = ready.surfaceUrl
          await refuseUnauthorized(await apiStatus(ready.surfaceUrl), 'API without credentials')
          const login = await globalThis.fetch(ready.surfaceUrl, { redirect: 'manual' })
          firstCookie = cookieOf(login)
          if (firstCookie === undefined) throw new Error('no session cookie from the handoff')
          const authorized = await apiStatus(ready.surfaceUrl, firstCookie)
          if (authorized !== 200) throw new Error(`cookie did not authorize: ${authorized}`)
        },
      })
      // Full restart: fresh authentication must retire the old credentials.
      await runInstalledApp({
        executable: install.executable,
        mode: 'auth',
        userData: fixture.userData,
        cwd: fixture.userData,
        async action({ waitFor }) {
          const ready = await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
          if (ready.surfaceUrl === firstSurfaceUrl)
            throw new Error('restart reused the surface URL')
          await refuseUnauthorized(
            await apiStatus(ready.surfaceUrl, firstCookie),
            'old cookie after restart',
          )
          const login = await globalThis.fetch(ready.surfaceUrl, { redirect: 'manual' })
          const fresh = cookieOf(login)
          if (fresh === undefined) throw new Error('fresh handoff gave no cookie')
          const ok = await apiStatus(ready.surfaceUrl, fresh)
          if (ok !== 200) throw new Error(`fresh cookie did not authorize: ${ok}`)
        },
      })
    } finally {
      await fixture.dispose()
    }
  }
}

function conversationScenario(install) {
  return async () => {
    const fixture = await createSharedHomeFixture()
    try {
      let sessionId
      await runInstalledApp({
        executable: install.executable,
        mode: 'conversation',
        userData: fixture.userData,
        cwd: fixture.cwd,
        timeoutMs: 300_000,
        async action({ waitFor }) {
          const ready = await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
          const client = await createWebApiClient(ready.surfaceUrl)
          sessionId = await driveOneTurn(client, {
            cwd: fixture.cwd,
            text: 'installed conversation round one',
          })
          // Wait for the turn to hit disk while the Host is still running:
          // the quit below disposes it.
          const created = await waitForSessionFile(fixture.home, sessionId)
          await waitForTurns(created.file, 1)
        },
      })
      await waitForLeaseGone(fixture.home)
      await runInstalledApp({
        executable: install.executable,
        mode: 'conversation',
        userData: fixture.userData,
        cwd: fixture.cwd,
        timeoutMs: 300_000,
        async action({ waitFor }) {
          const ready = await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
          const client = await createWebApiClient(ready.surfaceUrl)
          const listed = await client.rpc('session/list', { _request: {} })
          if (!listed.items.some((item) => item.sessionId === sessionId)) {
            throw new Error('restarted installed app lost the prior session')
          }
          const continued = await driveOneTurn(client, {
            cwd: fixture.cwd,
            sessionId,
            text: 'continue after the restart',
          })
          if (continued !== sessionId) throw new Error('continuation changed the session id')
        },
      })
      const sessions = await listSessions(fixture.home)
      const target = sessions.find((session) => session.header.id === sessionId)
      if (target === undefined) throw new Error('session vanished')
      const turns = await waitForTurns(target.file, 2)
      if (turns !== 2) throw new Error(`expected 2 turns, got ${turns}`)
    } finally {
      await fixture.dispose()
    }
  }
}

function sharedHomeScenario(install) {
  return async () => {
    // Desktop creates, the installed CLI continues; then the reverse.
    const fixture = await createSharedHomeFixture()
    try {
      let sessionId
      await runInstalledApp({
        executable: install.executable,
        mode: 'conversation',
        userData: fixture.userData,
        cwd: fixture.cwd,
        timeoutMs: 300_000,
        async action({ waitFor }) {
          const ready = await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
          const client = await createWebApiClient(ready.surfaceUrl)
          sessionId = await driveOneTurn(client, {
            cwd: fixture.cwd,
            text: 'desktop creates for the cli',
          })
          const created = await waitForSessionFile(fixture.home, sessionId)
          await waitForTurns(created.file, 1)
        },
      })
      const cliContinued = await runInstalledCli(
        install.cliEntry,
        ['--profile', 'headless', 'continue from the installed cli'],
        { home: fixture.home, cwd: fixture.cwd },
      )
      if (cliContinued.code !== 0) {
        throw new Error(
          `installed cli could not continue the desktop session (${cliContinued.code}): ${cliContinued.output.slice(-400)}`,
        )
      }
      const sessions = await listSessions(fixture.home)
      const target = sessions.find((session) => session.header.id === sessionId)
      if (target === undefined) throw new Error('cli continuation lost the session')
      await waitForTurns(target.file, 2)
    } finally {
      await fixture.dispose()
    }
  }
}

function cliBusyScenario(install) {
  return async () => {
    const fixture = await createSharedHomeFixture()
    try {
      await runInstalledApp({
        executable: install.executable,
        mode: 'shared-home',
        userData: fixture.userData,
        cwd: fixture.cwd,
        timeoutMs: 300_000,
        async action({ waitFor }) {
          // The lease exists only once the app booted; racing the CLI before
          // ui-ready lets the CLI win the lock instead of being refused.
          await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
          // While the installed app holds the lease, the CLI must be refused
          // before booting, and doctor --unlock must refuse to clean a live
          // owner.
          const busy = await runInstalledCli(
            install.cliEntry,
            ['--profile', 'headless', 'must-not-boot'],
            { home: fixture.home, cwd: fixture.cwd },
          )
          if (busy.code !== 3) {
            throw new Error(`busy refusal exit ${busy.code}: ${busy.output.slice(-300)}`)
          }
          if (!busy.output.includes('cannot use this home')) {
            throw new Error('busy refusal did not explain the lease')
          }
          const doctor = await runInstalledCli(install.cliEntry, ['doctor', '--unlock'], {
            home: fixture.home,
            cwd: fixture.cwd,
          })
          if (doctor.code === 0 && /clean|unlock|removed/i.test(doctor.output)) {
            throw new Error('doctor unlocked a home with a live owner')
          }
        },
      })
    } finally {
      await fixture.dispose()
    }
  }
}

function cliDoctorScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('doctor')
    try {
      const doctor = await runInstalledCli(install.cliEntry, ['doctor', '--unlock'], {
        home: fixture.home,
        cwd: fixture.userData,
      })
      if (doctor.code !== 0) {
        throw new Error(
          `doctor on an idle home exited ${doctor.code}: ${doctor.output.slice(-300)}`,
        )
      }
    } finally {
      await fixture.dispose()
    }
  }
}

function recoveryScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('recovery')
    const poisonPatch = 'cordis:\n  this: [is: not: valid: yaml\n'
    try {
      const profileDir = path.join(fixture.home, 'profiles', 'desktop')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await writeFile(
        path.join(profileDir, 'package.json'),
        `${JSON.stringify(
          {
            name: 'dsh-profile-desktop',
            private: true,
            dependencies: {},
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
          },
          undefined,
          2,
        )}\n`,
      )
      await writeFile(path.join(profileDir, 'cordis.patch.yml'), poisonPatch)
      const reports = await runInstalledApp({
        executable: install.executable,
        mode: 'recovery',
        userData: fixture.userData,
        cwd: fixture.userData,
        timeoutMs: 480_000,
        async action({ waitFor }) {
          await waitFor(
            (report) => report.kind === 'recovery' && report.step === 'recovery-view-reached',
            'recovery view on the installed app',
          )
          await waitFor(
            (report) => report.kind === 'recovery' && report.step === 'safe-mode-healthy',
            'real Safe Mode host healthy',
          )
        },
      })
      // Exactly one automatic relaunch before the view (rollback → relaunch →
      // fail again), i.e. two real normal Host boots.
      const failures = reports.filter((report) => report.kind === 'host-failed').length
      if (failures < 2) {
        throw new Error(`expected at least two failed normal boots, saw ${failures}`)
      }
      // The poisoned user patch must survive byte-exact (it is user content).
      const patchBytes = await readFile(
        path.join(fixture.home, 'profiles', 'desktop', 'cordis.patch.yml'),
        'utf8',
      )
      if (patchBytes !== poisonPatch) throw new Error('the poisoned user patch was modified')
      // The lease must be gone after the scripted quit.
      await waitForLeaseGone(fixture.home)
    } finally {
      await fixture.dispose()
    }
  }
}

function cliVersionScenario(install) {
  return async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-cli-cwd-'))
    // An isolated empty home: the passthrough admission must never resolve —
    // and therefore never read — the user's real ~/.dsh (an unset DSH_HOME
    // makes the bundled CLI fall back to it).
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-cli-home-'))
    try {
      const compatibility = JSON.parse(
        await readFile(path.join(repositoryRoot, 'docs', 'compatibility.json'), 'utf8'),
      )
      const version = await runInstalledCli(install.cliEntry, ['--version'], { cwd, home })
      if (version.code !== 0) throw new Error(`--version exited ${version.code}`)
      if (!version.output.includes(compatibility.dsh.npmVersion)) {
        throw new Error(
          `--version output does not carry the pinned DSH version ${compatibility.dsh.npmVersion}: ${version.output.trim().slice(0, 120)}`,
        )
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  }
}

function cliPluginScenario(install) {
  return async () => {
    const fixture = await makeControllerHome('plugin')
    const fixturePackage = path.join(fixture.userData, 'local-plugin')
    try {
      await mkdir(fixturePackage, { recursive: true })
      await writeFile(
        path.join(fixturePackage, 'package.json'),
        `${JSON.stringify(
          {
            name: '@fixture/local-plugin',
            version: '1.0.0',
            private: true,
            // Without this declaration upstream reconciles the package as a
            // plain dependency (with a warning) instead of a profile bundle.
            dsh: { bundle: { patch: './cordis.patch.yml' } },
          },
          undefined,
          2,
        )}\n`,
      )
      await writeFile(
        path.join(fixturePackage, 'cordis.patch.yml'),
        '# Minimal first-party fixture patch for the artifact-level plugin smoke.\n',
      )
      const added = await runInstalledCli(
        install.cliEntry,
        ['plugin', '--profile', 'desktop', 'add', fixturePackage],
        { home: fixture.home, cwd: fixture.userData, timeoutMs: 240_000 },
      )
      if (added.code !== 0) {
        throw new Error(`plugin add exited ${added.code}: ${added.output.slice(-500)}`)
      }
      const manifest = JSON.parse(
        await readFile(path.join(fixture.home, 'profiles', 'desktop', 'package.json'), 'utf8'),
      )
      if (manifest.dependencies?.['@fixture/local-plugin'] === undefined) {
        throw new Error('plugin add did not record the fixture dependency')
      }
      if (!manifest.dsh?.profile?.bundles?.includes('@fixture/local-plugin')) {
        throw new Error('plugin add did not reconcile the bundle list')
      }
      const installedPackage = path.join(
        fixture.home,
        'profiles',
        'desktop',
        'node_modules',
        '@fixture',
        'local-plugin',
        'package.json',
      )
      await readFile(installedPackage)
    } finally {
      await fixture.dispose()
    }
  }
}

/**
 * The app exits 0 only after its quit chain released the lease, but the
 * lock directory removal lands on disk a moment later; wait briefly and
 * dump the owner if it truly persists.
 */
async function waitForLeaseGone(home, timeoutMs = 10_000) {
  const lock = path.join(home, 'run', 'host.lock')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const gone = await access(lock)
      .then(() => false)
      .catch((error) => error.code === 'ENOENT')
    if (gone) return true
    if (Date.now() > deadline) {
      const owner = await readFile(path.join(lock, 'owner.json'), 'utf8').catch(
        () => '<unreadable>',
      )
      throw new Error(`home lease survived the app exit; owner: ${owner.slice(0, 300)}`)
    }
    await new Promise((resolve) => sleepTimer(resolve, 250))
  }
}

async function waitForSessionFile(home, sessionId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const sessions = await listSessions(home)
    const found = sessions.find((session) => session.header.id === sessionId)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`session ${sessionId} did not persist`)
    await new Promise((resolve) => sleepTimer(resolve, 250))
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function readArtifactRecord() {
  const artifacts = JSON.parse(
    await readFile(path.join(repositoryRoot, 'release', 'artifacts.json'), 'utf8'),
  )
  const mine = artifacts.filter((record) => record.arch === process.arch)
  if (mine.length !== 1) {
    throw new Error(
      `expected exactly one ${process.arch} artifact record, found ${mine.length}; run package:dmg`,
    )
  }
  const file = path.join(repositoryRoot, mine[0].file)
  // The index must describe the BYTES on disk: after a rebuild without
  // package:dmg the stale record would smoke the previous candidate green.
  const bytes = await readFile(file)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== mine[0].sha256) {
    throw new Error(
      `release/artifacts.json is stale: ${mine[0].file} hashes ${digest.slice(0, 12)} ` +
        `but the record pins ${mine[0].sha256.slice(0, 12)}; re-run package:dmg`,
    )
  }
  return { record: mine[0], file }
}

const { record: artifactRecord, file: dmg } = await readArtifactRecord()
console.log(
  `PKG-SMOKE candidate: ${artifactRecord.file} (${artifactRecord.releaseId}, sha ${artifactRecord.sha256.slice(0, 12)}…)`,
)
const install = await installFromDmg(dmg, PRODUCT_NAME)
console.log(`PKG-SMOKE installed to ${install.installDirectory}`)

try {
  await record('installed-dsh-ui', dshUiScenario(install))
  await record('installed-loading-page', loadingPageScenario(install))
  await record('installed-host-crash', hostCrashScenario(install))
  await record('installed-navigation', navigationScenario(install))
  await record('installed-lifecycle', lifecycleScenario(install))
  await record('installed-auth', authScenario(install))
  await record('installed-conversation', conversationScenario(install))
  await record('installed-shared-home', sharedHomeScenario(install))
  await record('installed-cli-version', cliVersionScenario(install))
  await record('installed-cli-busy', cliBusyScenario(install))
  await record('installed-cli-doctor', cliDoctorScenario(install))
  await record('installed-cli-plugin', cliPluginScenario(install))
  await record('installed-recovery', recoveryScenario(install))
  await record('installed-controller-recovery', () =>
    runControllerScenario(install, 'recovery-chain'),
  )
  await record('installed-controller-admission', () => runControllerScenario(install, 'admission'))
  await record('installed-controller-safemode', () => runControllerScenario(install, 'safe-mode'))
} finally {
  await install.dispose()
}

await writeFile(
  path.join(repositoryRoot, 'release', 'package-smoke.json'),
  `${JSON.stringify(
    { candidate: artifactRecord, results, completedAt: new Date().toISOString() },
    undefined,
    2,
  )}\n`,
)
const failed = results.filter((entry) => !entry.ok)
if (failed.length > 0) {
  console.error(`PKG-SMOKE failed (${failed.length}/${results.length}):`)
  for (const entry of failed) console.error(`- ${entry.name}: ${entry.error}`)
  process.exit(1)
}
console.log(`PKG-SMOKE passed (${results.length}/${results.length} scenarios)`)
