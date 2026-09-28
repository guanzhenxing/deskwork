import { randomUUID } from 'node:crypto'

import { utilityProcess, type UtilityProcess } from 'electron'

import type {
  HostBootstrap,
  HostProcessFactory,
  ManagedHostProcess,
} from '@dsh-desktop/host-supervisor'
import { assertBootProfile } from '@dsh-desktop/host-supervisor/boot-profile'

import { sanitizeHostEnvironment } from './host-environment.js'

type ElectronHostBootstrap = Omit<HostBootstrap, 'mode'> & {
  mode: HostBootstrap['mode']
  startIdentity: string
}

class ElectronManagedHostProcess implements ManagedHostProcess {
  readonly pid: number
  readonly startIdentity: string
  readonly #child: UtilityProcess

  constructor(child: UtilityProcess, pid: number, startIdentity: string) {
    this.#child = child
    this.pid = pid
    this.startIdentity = startIdentity
  }

  deliverBootstrap(bootstrap: HostBootstrap): void {
    const profile = assertBootProfile({
      mode: bootstrap.mode,
      profileName: bootstrap.profileName,
    })
    if (!profile.ok) throw new Error(`Electron Host bootstrap invalid: ${profile.reason}`)
    const privateBootstrap: ElectronHostBootstrap = {
      ...bootstrap,
      mode: bootstrap.mode,
      startIdentity: this.startIdentity,
    }
    this.#child.postMessage({ kind: 'dsh-desktop-bootstrap', bootstrap: privateBootstrap })
  }

  postMessage(message: unknown): void {
    this.#child.postMessage(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#child.on('message', listener)
    return () => this.#child.off('message', listener)
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    const onExit = (code: number): void => listener({ code, signal: null })
    this.#child.on('exit', onExit)
    return () => this.#child.off('exit', onExit)
  }

  terminate(): void {
    this.#child.kill()
  }

  kill(): void {
    process.kill(this.pid, 'SIGKILL')
  }
}

/**
 * Forks the Host utility process without boot credentials. The supervisor
 * registers the child's OS identity on the home lease first and only then
 * delivers the bootstrap message through `deliverBootstrap`.
 */
export function createElectronHostProcessFactory(input: {
  hostEntry: string
  /**
   * Node's on-disk compile cache for the Host's module graph: the upstream
   * runtime's cold boot spends most of its wall time compiling hundreds of
   * modules, and the cache removes that work from every boot after the
   * first.
   */
  compileCache?: Readonly<{ preloadPath: string; cacheDirectory: string }>
}): HostProcessFactory {
  return {
    async spawnWaiting() {
      const startIdentity = randomUUID()
      const sanitized = sanitizeHostEnvironment(process.env)
      const env =
        input.compileCache === undefined
          ? sanitized
          : {
              ...sanitized,
              // Sanitization stripped any inherited NODE_OPTIONS; the
              // compile-cache preload is the single deliberate addition.
              // The quotes carry resource paths with spaces.
              NODE_OPTIONS: `--require "${input.compileCache.preloadPath}"`,
              DSH_HOST_COMPILE_CACHE: input.compileCache.cacheDirectory,
            }
      const child = utilityProcess.fork(input.hostEntry, [], {
        env,
        serviceName: 'Deskwork Host',
        stdio: 'ignore',
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      if (child.pid === undefined) throw new Error('Electron utility process has no PID')
      return new ElectronManagedHostProcess(child, child.pid, startIdentity)
    },
  }
}
