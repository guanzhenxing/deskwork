// Driven by tests/smoke/package.mjs against an INSTALLED app's runtime-host
// closure (no repository imports). Scenario: the M2 recovery chain
// (attributed failure → rollback → one relaunch → recovery view), the M3
// admission gate (unsupported data epoch → fail-closed, no writes), and a
// real Safe Mode Host boot through the installed dependency closure.
//
// argv: node installed-controller-driver.mjs <installResourcesRoot> <scenario> <home>
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [installRoot, scenario, home] = process.argv.slice(2)
if (!installRoot || !scenario || !home) {
  throw new Error('usage: installed-controller-driver.mjs <installRoot> <scenario> <home>')
}

const hostRoot = path.join(installRoot, 'runtime-host')
const shellCore = await import(
  path.join(hostRoot, 'node_modules', '@deskwork', 'shell-core', 'lib', 'index.js')
)
const homeLease = await import(
  path.join(hostRoot, 'node_modules', '@deskwork', 'home-lease', 'lib', 'index.js')
)
const releaseCompatibility = await import(
  path.join(hostRoot, 'node_modules', '@deskwork', 'release-compatibility', 'lib', 'index.js')
)

const { RecoverySessionController, StartupFailureError, createDesktopProfileRecovery } = shellCore
const { acquireHomeLease, createInProcessGuardLock } = homeLease

function report(payload) {
  console.log(`PKG-CTRL ${JSON.stringify(payload)}`)
}

const sameProbe = () => ({
  async current() {
    return { pid: process.pid, startIdentity: 'pkg-driver' }
  },
  async identify(pid) {
    return { pid, startIdentity: 'pkg-driver' }
  },
  async inspect() {
    return 'same'
  },
  async scanSupported() {
    return 'none'
  },
})

const attributedFailure = new StartupFailureError({
  stage: 'resolve-profile',
  code: 'PROFILE_INVALID',
  category: 'profile-composition',
  summary: 'composed profile cannot be resolved',
  retryable: false,
})

async function leasedSession(homeDir, options) {
  const lease = await acquireHomeLease({
    home: homeDir,
    entrypoint: 'desktop',
    profile: 'deskwork',
    appVersion: '0.0.0',
    probe: sameProbe(),
    guard: createInProcessGuardLock(),
  })
  const session = { attempts: [], views: [] }
  session.controller = new RecoverySessionController({
    acquireLease: async () => lease,
    profile: createDesktopProfileRecovery({ home: homeDir, profileName: 'deskwork' }),
    admitHome: () => releaseCompatibility.admitHome({ home: homeDir }),
    createAttempt: (_lease, mode) => {
      session.attempts.push(mode)
      return {
        start: () => options.boot(session.attempts.length, mode),
        stop: async () => undefined,
      }
    },
    loadSurface: async () => undefined,
    window: {
      showRecoveryView: async (view) => {
        session.views.push(view)
      },
      destroySurface: () => undefined,
    },
  })
  session.lease = lease
  return session
}

const sentinel = (name) => `# sentinel ${name}\n`

async function seedSentinels(homeDir) {
  await writeFile(path.join(homeDir, '.credentials.yaml'), sentinel('credentials'), { mode: 0o600 })
  await writeFile(path.join(homeDir, 'settings.yaml'), sentinel('settings'), { mode: 0o600 })
  await writeFile(path.join(homeDir, 'cordis.patch.yml'), sentinel('home-patch'), { mode: 0o600 })
}

async function assertSentinels(homeDir) {
  for (const [name, file] of [
    ['credentials', '.credentials.yaml'],
    ['settings', 'settings.yaml'],
    ['home-patch', 'cordis.patch.yml'],
  ]) {
    const bytes = await readFile(path.join(homeDir, file), 'utf8')
    if (bytes !== sentinel(name)) throw new Error(`home sentinel ${file} was modified`)
  }
}

async function recoveryChainScenario() {
  await mkdir(path.join(home, 'profiles', 'deskwork'), { recursive: true, mode: 0o700 })
  await seedSentinels(home)
  const session = await leasedSession(home, {
    boot: () => Promise.reject(attributedFailure),
  })
  await session.controller.start().catch(() => undefined)
  const normalBoots = session.attempts.filter((mode) => mode === 'normal').length
  if (normalBoots !== 2) throw new Error(`expected 2 normal boots (1 relaunch), got ${normalBoots}`)
  if (session.views.length !== 1) throw new Error('expected exactly one recovery view')
  if (session.views[0].failure.category !== 'profile-composition') {
    throw new Error(`unexpected category ${session.views[0].failure.category}`)
  }
  const manifest = path.join(home, 'profiles', 'deskwork', 'package.json')
  await readFile(manifest).then(
    () => {
      throw new Error('rollback left a created manifest behind')
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
  await assertSentinels(home)
  await session.controller.act('quit')
  report({ scenario: 'recovery-chain', ok: true, normalBoots, views: session.views.length })
}

async function admissionScenario() {
  await mkdir(path.join(home, 'profiles', 'deskwork'), { recursive: true, mode: 0o700 })
  await mkdir(path.join(home, 'run'), { recursive: true })
  await writeFile(
    path.join(home, 'run', 'compatibility.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      dataEpoch: 2,
      lastWriterReleaseId: 'future-test-fixture',
      formats: {},
    })}\n`,
  )
  await seedSentinels(home)
  const session = await leasedSession(home, {
    boot: () => {
      throw new Error('no Host attempt may be created when admission refuses')
    },
  })
  await session.controller.start().catch(() => undefined)
  if (session.attempts.length !== 0)
    throw new Error('admission refusal still created a Host attempt')
  if (session.views.length !== 1) throw new Error('admission refusal showed no recovery view')
  const view = session.views[0]
  if (view.failure.code !== 'HOME_DATA_UNSUPPORTED') {
    throw new Error(`unexpected admission code ${view.failure.code}`)
  }
  if (view.retryAllowed !== false || view.safeModeAllowed !== false) {
    throw new Error('admission view must withdraw retry and safe mode')
  }
  await assertSentinels(home)
  // The marker bytes themselves are untouched.
  const marker = JSON.parse(await readFile(path.join(home, 'run', 'compatibility.json'), 'utf8'))
  if (marker.dataEpoch !== 2) throw new Error('admission modified the marker')
  await session.controller.act('quit')
  report({ scenario: 'admission-refusal', ok: true, code: view.failure.code })
}

async function safeModeScenario() {
  // Same shape as the M2 session-level smoke: the normal profile fails, the
  // controller's Safe Mode entry prepares the fixed first-party profile
  // itself, and the safe attempt becomes healthy — all through code from the
  // installed closure.
  const normalDir = path.join(home, 'profiles', 'deskwork')
  await mkdir(normalDir, { recursive: true, mode: 0o700 })
  await writeFile(
    path.join(normalDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: { '@fixture/hostile': 'file:./hostile' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@fixture/hostile'] } },
      },
      undefined,
      2,
    )}\n`,
  )
  const session = await leasedSession(home, {
    boot: (index, mode) => {
      if (mode === 'safe') {
        return Promise.resolve({
          pid: process.pid,
          startIdentity: 'safe-ready',
          surface: { kind: 'loopback', url: 'http://127.0.0.1:43125/?token=x' },
          origin: 'http://127.0.0.1:43125',
        })
      }
      throw new StartupFailureError({
        stage: 'boot',
        code: 'BOOT_FAILED',
        category: 'runtime',
        summary: 'hostile profile failed to boot',
        retryable: true,
      })
    },
  })
  await session.controller.start().catch(() => undefined)
  if (session.controller.state !== 'recovery') throw new Error('normal boot did not reach recovery')
  await session.controller.act('safe-mode')
  if (session.controller.state !== 'healthy') {
    throw new Error(`safe mode did not become healthy (${session.controller.state})`)
  }
  if (session.attempts.at(-1) !== 'safe') throw new Error('safe-mode ran a normal attempt')
  // The safe profile was prepared with exactly the three first-party bundles.
  const safeManifest = JSON.parse(
    await readFile(path.join(home, 'profiles', 'desktop-safe-mode', 'package.json'), 'utf8'),
  )
  if (safeManifest.dsh.profile.bundles.length !== 3) {
    throw new Error('safe profile does not hold exactly the first-party bundle set')
  }
  const normalManifest = await readFile(path.join(normalDir, 'package.json'), 'utf8')
  if (!normalManifest.includes('@fixture/hostile')) {
    throw new Error('safe mode rewrote the normal profile')
  }
  await session.controller.act('quit')
  report({ scenario: 'safe-mode-controller', ok: true })
}

const scenarios = {
  'recovery-chain': recoveryChainScenario,
  admission: admissionScenario,
  'safe-mode': safeModeScenario,
}

const runner = scenarios[scenario]
if (runner === undefined) throw new Error(`unknown scenario ${scenario}`)
await runner()
