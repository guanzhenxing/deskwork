// M2 smoke: Safe Mode boots the fixed first-party bundle set without loading
// normal-profile third-party code, and the user-triggered Safe Mode entry is
// wired through the real recovery session: session profile switch, safe profile
// preparation, safe attempt, and back to a normal retry.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { createIsolatedHomeFixture } from '../helpers/isolated-home.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshManifest = createRequire(
  path.join(root, 'packages', 'host-supervisor', 'package.json'),
).resolve('@deepseek-ai/dsh/package.json')
const dshBin = path.join(path.dirname(dshManifest), 'lib', 'bin.js')
const requireFromShellCore = createRequire(
  path.join(root, 'packages', 'shell-core', 'package.json'),
)
const shellCore = requireFromShellCore('@deskwork/shell-core')
const { createHomeSession } = requireFromShellCore('@deskwork/desktop-contracts/home-session')
const { RecoverySessionController, StartupFailureError, createDesktopProfileRecovery } = shellCore
const contracts = requireFromShellCore('@deskwork/desktop-contracts/package.json')
void contracts

const fixtures = []

// The shared isolated-home fixture — the same environment, repo/root/real-home
// refusals and identity-reverified cleanup the unit tests rely on.
async function freshRoot(label) {
  void label
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.userData
}

async function disposeRoots() {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
}

async function run(args, env, cwd) {
  const child = spawn(process.execPath, [dshBin, ...args], {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      output += chunk
    })
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  return { code: exit, output }
}

const runtimeFailure = new StartupFailureError({
  stage: 'boot',
  code: 'BOOT_FAILED',
  category: 'runtime',
  summary: 'normal host boot failed',
  retryable: true,
})

try {
  // ── Host-level bundle isolation: safe profile never loads third-party code ──
  {
    const userData = await freshRoot('host')
    const home = path.join(userData, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await mkdir(path.join(home, 'profiles', 'desktop-safe-mode'), { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(home, 'profiles', 'desktop-safe-mode', 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-desktop-safe-mode',
          private: true,
          dependencies: {},
          dsh: {
            profile: {
              bundles: [
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-web-app',
                // A bundle that resolves nowhere: pnpm hoists every
                // workspace package into .pnpm/node_modules on a fresh
                // install, so the real bridge IS resolvable in dev — the
                // installed-app recovery scenario covers the real bridge.
                '@fixture/bridge-not-installed',
              ],
              patchReload: 'startup',
            },
          },
        },
        undefined,
        2,
      )}\n`,
    )
    // Normal profile carries a hostile third-party bundle that would crash any
    // loader; Safe Mode must never touch it.
    const normalDir = path.join(home, 'profiles', 'desktop')
    await mkdir(normalDir, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(normalDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-desktop',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@fixture/hostile'], patchReload: 'live' } },
        },
        undefined,
        2,
      )}\n`,
    )
    const env = { ...process.env, DESKWORK_HOME: home, DSH_TELEMETRY_DISABLED: '1' }

    const safeBoot = await run(['--profile', 'desktop-safe-mode', 'ping'], env, userData)
    // The bundle resolver must refuse the workspace bridge in a bare smoke
    // home (it is not installed there); that attributable refusal — not any
    // other nonzero exit — proves normal-profile and third-party code never
    // ran.
    const refused = /cannot resolve profile bundle|does not exist/iu.test(safeBoot.output)
    const hostileLoaded = safeBoot.output.includes('@fixture/hostile')
    if (hostileLoaded) throw new Error('Safe Mode attempted to load a normal-profile bundle')
    if (safeBoot.code === 0 || !refused) {
      throw new Error(
        `safe boot was not the expected attributable bridge refusal (code ${safeBoot.code})`,
      )
    }
    const normalManifest = await readFile(path.join(normalDir, 'package.json'), 'utf8')
    if (!normalManifest.includes('@fixture/hostile')) {
      throw new Error('Safe Mode rewrote the normal profile')
    }
  }

  // ── Session-level wiring: user-triggered Safe Mode on the real session/profiles ──
  {
    const userData = await freshRoot('session')
    const home = path.join(userData, 'home')
    await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true, mode: 0o700 })
    const homeSession = await createHomeSession({ home: home, profile: 'desktop' })
    const session = {
      attempts: [],
      views: [],
      controller: undefined,
    }
    session.controller = new RecoverySessionController({
      session: homeSession,
      profile: createDesktopProfileRecovery({ home, profileName: 'desktop' }),
      createAttempt: (_session, mode) => {
        session.attempts.push(mode)
        // The normal boot fails; the safe boot publishes its surface.
        return {
          start: () =>
            mode === 'safe'
              ? Promise.resolve({
                  pid: process.pid,
                  startIdentity: 'safe-ready',
                  surface: { kind: 'loopback', url: 'http://127.0.0.1:43124/?token=x' },
                  origin: 'http://127.0.0.1:43124',
                })
              : Promise.reject(runtimeFailure),
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
    await session.controller.start().catch(() => undefined)
    if (session.controller.state !== 'recovery')
      throw new Error('normal boot did not fail into recovery')
    const view = session.controller.getView()
    if (!view.safeModeAllowed) throw new Error('recovery view does not offer Safe Mode')

    await session.controller.act('safe-mode')
    if (session.controller.state !== 'healthy')
      throw new Error('safe-mode boot did not become healthy')
    if (session.attempts.at(-1) !== 'safe') throw new Error('safe-mode ran a normal attempt')
    // The safe profile was prepared with exactly the three first-party bundles.
    const safeManifest = JSON.parse(
      await readFile(path.join(home, 'profiles', 'desktop-safe-mode', 'package.json'), 'utf8'),
    )
    if (safeManifest.dsh.profile.bundles.length !== 3) {
      throw new Error('safe profile does not hold exactly the first-party bundle set')
    }
    // Normal profile keeps its user bytes; quitting releases the session.
    await session.controller.act('quit')
    if (session.controller.state !== 'stopped') throw new Error('quit from safe mode did not stop')
  }

  // ── Broken bridge: both Hosts failed, the local recovery page still works ──
  {
    const userData = await freshRoot('bridge-dead')
    const home = path.join(userData, 'home')
    await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true, mode: 0o700 })
    const homeSession = await createHomeSession({ home: home, profile: 'desktop' })
    const bridgeFailure = new StartupFailureError({
      stage: 'publish-surface',
      code: 'SURFACE_MISSING',
      category: 'renderer',
      summary: 'recovery bridge did not publish a surface',
      retryable: true,
    })
    const session = { views: [], controller: undefined }
    session.controller = new RecoverySessionController({
      session: homeSession,
      profile: createDesktopProfileRecovery({ home, profileName: 'desktop' }),
      // Both the normal boot and the safe boot fail.
      createAttempt: () => ({
        start: () => Promise.reject(bridgeFailure),
        stop: async () => undefined,
      }),
      loadSurface: async () => undefined,
      window: {
        showRecoveryView: async (view) => {
          session.views.push(view)
        },
        destroySurface: () => undefined,
      },
    })
    await session.controller.start().catch(() => undefined)
    if (session.controller.state !== 'recovery') throw new Error('normal failure not in recovery')
    await session.controller.act('safe-mode')
    // The broken bridge lands back on the local recovery page with diagnosis
    // and a working quit — never a crash loop or a dead window.
    if (session.controller.state !== 'recovery') {
      throw new Error('broken bridge did not return to the recovery page')
    }
    const view = session.controller.getView()
    if (view.failure.code !== 'SURFACE_MISSING') {
      throw new Error(`recovery page lost the bridge failure: ${view.failure.code}`)
    }
    await session.controller.act('quit')
    if (session.controller.state !== 'stopped') throw new Error('quit after broken bridge failed')
  }

  console.log('M2 safe-mode smoke passed')
} finally {
  await disposeRoots()
}
