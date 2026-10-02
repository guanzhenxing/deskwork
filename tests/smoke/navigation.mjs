// M3 navigation smoke: popups are always denied, the main frame stays on the
// authenticated surface, and only policy-approved https links reach the
// external path — recorded by the injected adapter instead of the user's
// browser. A separate manual system external-link check covers real
// shell.openExternal behavior.
import { createDesktopSmokeRoot } from '../helpers/desktop-smoke-root.mjs'
import { ensureLauncherBuilt, withDesktop } from '../helpers/desktop-driver.mjs'

await ensureLauncherBuilt()
const root = await createDesktopSmokeRoot()

try {
  await withDesktop(
    root.home,
    root.userData,
    async ({ surfaceUrl, reports, waitForReport }) => {
      const done = await waitForReport((report) => report.kind === 'navigation-probe-done')
      const external = reports
        .filter((report) => report.kind === 'external-opened')
        .map((report) => report.url)
      const expected = ['https://example.com/popup-approved']
      if (JSON.stringify(external) !== JSON.stringify(expected)) {
        throw new Error(
          `external handoff mismatch: got ${JSON.stringify(external)}, expected ${JSON.stringify(expected)}`,
        )
      }
      // The denied file/loopback targets — and script-driven main-frame
      // navigation of ANY kind — must never reach the external path.
      for (const report of reports) {
        if (report.kind === 'external-opened' && /127\.0\.0\.1|file:|token/.test(report.url)) {
          throw new Error(`denied target reached the external path: ${report.url}`)
        }
        if (report.kind === 'external-opened' && report.url.includes('main-frame-blocked')) {
          throw new Error('script-driven navigation reached the system browser')
        }
      }
      // Blocked main-frame navigation leaves the page on the surface origin.
      const origin = new URL(surfaceUrl).origin
      if (!done.currentUrl.startsWith(origin)) {
        throw new Error(`main frame left the surface origin: ${done.currentUrl}`)
      }
      console.log('M3 navigation smoke passed (recorded external adapter)')
    },
    'navigation',
  )
} finally {
  await root.dispose()
}
