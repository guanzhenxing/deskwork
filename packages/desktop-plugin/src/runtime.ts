import {
  validateLoopbackSurface,
  type DesktopSurfaceService,
} from '@deskwork/desktop-contracts/host-control'

export type { DesktopSurfaceService } from '@deskwork/desktop-contracts/host-control'

export interface DesktopSurfacePublisherServices {
  connection: { authenticatedUrl(baseUrl: string): string }
  webServer: { host: string; port: number }
  desktopSurface?: DesktopSurfaceService | undefined
}

export type DesktopSurfacePublishResult = 'scheduled' | 'already-scheduled' | 'degraded'

export function createDesktopSurfacePublisher(logger: { warn(message: string): void } = console): {
  publish(services: DesktopSurfacePublisherServices): DesktopSurfacePublishResult
} {
  let scheduled = false
  let warned = false
  return {
    publish(services) {
      if (scheduled) return 'already-scheduled'
      if (services.desktopSurface === undefined) {
        if (!warned) {
          warned = true
          logger.warn(
            'desktop-plugin: launcher surface is unavailable; continuing as a normal DSH Web host',
          )
        }
        return 'degraded'
      }
      if (services.webServer.host !== '127.0.0.1') {
        throw new Error('desktop-plugin: desktop surface requires an exact loopback Web bind')
      }
      const surface = {
        kind: 'loopback' as const,
        url: services.connection.authenticatedUrl(
          `http://127.0.0.1:${String(services.webServer.port)}`,
        ),
      }
      validateLoopbackSurface(surface)
      services.desktopSurface.schedule(surface)
      scheduled = true
      return 'scheduled'
    },
  }
}
