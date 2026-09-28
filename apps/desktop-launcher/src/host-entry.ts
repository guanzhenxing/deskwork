import type { HostBootstrap } from '@deskwork/host-supervisor'
import { runDshHost, type HostControlTransport } from '@deskwork/host-supervisor/host-runner'
import { assertBootProfile, type BootMode } from '@deskwork/host-supervisor/boot-profile'

// Must run before the dynamically loaded upstream app graph starts
// compiling. The launcher also injects a --require preload for the same
// purpose; this in-graph enabler covers every entry route (and is a no-op
// when the preload already armed the cache).
try {
  const cacheDir = process.env.DSH_HOST_COMPILE_CACHE
  const nodeModule = (await import('node:module')) as {
    enableCompileCache?: (directory?: string) => unknown
  }
  nodeModule.enableCompileCache?.(cacheDir === undefined || cacheDir === '' ? undefined : cacheDir)
} catch {
  /* uncached boot is always safe */
}

type ElectronHostBootstrap = Omit<HostBootstrap, 'mode'> & {
  mode: BootMode
  startIdentity: string
}

function isBootstrap(value: unknown): value is ElectronHostBootstrap {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  if (
    typeof input.home !== 'string' ||
    typeof input.profileName !== 'string' ||
    (input.mode !== 'normal' && input.mode !== 'safe') ||
    typeof input.capability !== 'string' ||
    input.capability.length < 32 ||
    typeof input.leaseGeneration !== 'string' ||
    typeof input.startIdentity !== 'string'
  ) {
    return false
  }
  return assertBootProfile({ mode: input.mode, profileName: input.profileName }).ok
}

async function main(): Promise<void> {
  const parentPort = process.parentPort
  if (parentPort === null) {
    throw new Error('Host runner requires an Electron parent port')
  }
  // The launcher is gone: dispose quietly instead of lingering without a
  // control channel (and therefore without anyone holding the lease). The
  // ParentPort typings only list "message", but the port is an EventEmitter
  // that also reports channel teardown.
  ;(parentPort as NodeJS.EventEmitter).on('close', () => {
    process.exit(0)
  })
  const bootstrap = await new Promise<ElectronHostBootstrap>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Host bootstrap timed out')), 10_000)
    parentPort.once('message', (event) => {
      clearTimeout(timeout)
      const input = event.data as { kind?: unknown; bootstrap?: unknown }
      if (input?.kind !== 'dsh-desktop-bootstrap' || !isBootstrap(input.bootstrap)) {
        reject(new Error('Host bootstrap is invalid'))
        return
      }
      resolve(input.bootstrap)
    })
  })
  const transport: HostControlTransport = {
    postMessage: (message) => parentPort.postMessage(message),
    onMessage(listener) {
      const onMessage = (event: Electron.MessageEvent): void => listener(event.data)
      parentPort.on('message', onMessage)
      return () => parentPort.off('message', onMessage)
    },
  }
  const host = await runDshHost({
    ...bootstrap,
    hostIdentity: { pid: process.pid, startIdentity: bootstrap.startIdentity },
    transport,
  })
  await host.disposed
}

void main().then(
  () => {
    process.exitCode = 0
  },
  () => {
    console.error('dsh-desktop Host failed')
    process.exitCode = 1
  },
)
