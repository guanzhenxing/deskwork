// M3 lifecycle smoke: closing hides to the tray, the tray and Dock paths
// restore the window, a duplicate launch focuses instead of booting, a
// renderer crash reloads exactly once before the local recovery view takes
// over, and quitting releases the Host and the home lease.
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as sleepTimer } from 'node:timers'
import { fileURLToPath } from 'node:url'

import { createDesktopSmokeRoot } from '../helpers/desktop-smoke-root.mjs'
import { ensureLauncherBuilt, waitUntilDead, withDesktop } from '../helpers/desktop-driver.mjs'

await ensureLauncherBuilt()
const root = await createDesktopSmokeRoot()
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const launcherDirectory = path.join(repositoryRoot, 'apps', 'desktop-launcher')
const electronBinary = createRequire(path.join(launcherDirectory, 'package.json'))('electron')

function launchDuplicateInstance() {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, ['.'], {
      cwd: launcherDirectory,
      env: {
        ...process.env,
        DSH_DESKTOP_SMOKE: 'lifecycle',
        DSH_DESKTOP_M0_USER_DATA: root.userData,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

try {
  await withDesktop(
    root.home,
    root.userData,
    async ({ reports, waitForReport }) => {
      const step = (name) =>
        waitForReport((report) => report.kind === 'lifecycle' && report.step === name)

      const closeHidden = await step('close-hidden')
      if (closeHidden.visible !== false || closeHidden.destroyed !== false) {
        throw new Error(
          `close-to-tray failed: visible=${closeHidden.visible} destroyed=${closeHidden.destroyed}`,
        )
      }
      const trayShown = await step('tray-shown')
      if (trayShown.visible !== true) throw new Error('tray show did not restore the window')
      const dock = await step('dock-activated')
      if (dock.visible !== true) throw new Error('Dock activation did not restore the window')

      // A duplicate launch must focus the running instance and exit itself.
      const duplicate = await Promise.race([
        launchDuplicateInstance(),
        new Promise((_, reject) =>
          sleepTimer(() => reject(new Error('duplicate launch hung')), 60_000),
        ),
      ])
      if (duplicate.code !== 0) {
        throw new Error(`duplicate instance exited with ${duplicate.code} ${duplicate.signal}`)
      }
      await waitForReport((report) => report.kind === 'second-instance-focused')

      // Renderer crash budget: one reload, then the local recovery view.
      await waitForReport((report) => report.kind === 'renderer-reloaded')
      await step('renderer-reload-verified')
      await waitForReport((report) => report.kind === 'renderer-crashed')
      await waitForReport(
        (report) => report.kind === 'recovery-view' && report.code === 'RENDERER_CRASHED',
      )
      await step('sequence-done')

      const ready = reports.find((report) => report.kind === 'ui-ready')
      for (const pid of [ready.launcherPid, ready.hostPid]) await waitUntilDead(pid, 20_000)

      const lock = path.join(root.home, 'run', 'host-owner.json')
      const leftover = await access(lock)
        .then(() => 'present')
        .catch((error) => (error.code === 'ENOENT' ? undefined : 'unreadable'))
      if (leftover !== undefined)
        throw new Error(`host owner record survived the quit (${leftover})`)

      console.log('M3 lifecycle smoke passed')
    },
    'lifecycle',
  )
} finally {
  await root.dispose()
}
