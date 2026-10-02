import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

import type { DesktopSurfaceService } from '@deskwork/desktop-contracts/host-control'

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopSurface?: DesktopSurfaceService
  }
}

export const name = 'desktop-recovery-bridge'

/**
 * Safe Mode's surface publisher: wait for the connection and web server, then
 * hand the launcher the authenticated loopback URL exactly once.
 *
 * This is the minimal first-party bundle — no plugin market, no profile
 * changes, no product settings, no update policy — so a broken normal profile
 * cannot take the recovery surface down with it. When the launcher surface is
 * absent the bridge still serves the official Web UI on loopback and says so;
 * that degradation is the whole point of Safe Mode, not a failure.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection', 'webServer'], (readyContext) => {
    const { connection, webServer } = readyContext
    if (webServer.host !== '127.0.0.1') {
      throw new Error('recovery bridge requires an exact loopback Web bind')
    }
    const url = connection.authenticatedUrl(`http://127.0.0.1:${String(webServer.port)}`)
    const desktopSurface = readyContext.get('desktopSurface')
    if (desktopSurface === undefined) {
      ctx.logger.warn('recovery-bridge: launcher surface unavailable; degraded recovery web host')
      return
    }
    desktopSurface.schedule({ kind: 'loopback', url })
    ctx.logger.info('recovery-bridge: recovery surface scheduled')
  })
}
