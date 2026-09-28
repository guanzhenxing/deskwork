import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { createRecoverySurfacePublisher } from './runtime.js'
import type { DesktopSurfaceService } from '@deskwork/desktop-contracts/host-control'

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopSurface?: DesktopSurfaceService
  }
}

export * from './runtime.js'

export const name = 'desktop-recovery-bridge'

export function apply(ctx: Context): void {
  const publisher = createRecoverySurfacePublisher(ctx)
  ctx.inject(['connection', 'webServer'], (readyContext) => {
    const desktopSurface = readyContext.get('desktopSurface')
    const url = readyContext.connection.authenticatedUrl(
      `http://127.0.0.1:${String(readyContext.webServer.port)}`,
    )
    if (desktopSurface === undefined) {
      ctx.logger.warn('recovery-bridge: launcher surface unavailable; degraded recovery web host')
      publisher.publish(readyContext as never)
      return
    }
    desktopSurface.schedule({ kind: 'loopback', url })
    publisher.publish(readyContext as never)
  })
}
