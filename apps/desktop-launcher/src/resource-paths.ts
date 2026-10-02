import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const launcherDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type NativeAssetPaths = Readonly<{ trayIcon: string; trayIcon2x: string }>

/**
 * Tray template images. Development reads the generated files under
 * `release/icons`; a packaged build reads the same files copied next to the
 * runtime under `Contents/Resources/icons`. Missing assets disable the tray
 * (the caller decides whether that is fatal for its context).
 */
export function resolveNativeAssets(
  input: Readonly<{
    isPackaged: boolean
    resourcesPath: string
  }>,
): NativeAssetPaths | undefined {
  const base = input.isPackaged
    ? path.join(input.resourcesPath, 'icons')
    : path.join(launcherDirectory, '..', '..', 'release', 'icons')
  const trayIcon = path.join(base, 'trayTemplate.png')
  const trayIcon2x = path.join(base, 'trayTemplate@2x.png')
  if (!existsSync(trayIcon) || !existsSync(trayIcon2x)) return undefined
  return { trayIcon, trayIcon2x }
}

export { launcherDirectory }

export type InstalledRuntimePaths = Readonly<{
  hostEntry: string
  hostInstallAnchor: string
  recoveryHtml: string
  recoveryPreload: string
  compileCachePreload: string
  loadingHtml: string
  compatibilityManifest: string
  trayIcon: string
}>

/**
 * The fixed installed-resource layout produced by `scripts/stage-runtime.mjs`
 * and electron-builder's extraResources. Runtime paths are derived only from
 * the explicit app resources root — never by scanning the repository, a pnpm
 * store, or the system.
 */
export function resolveInstalledRuntime(resourcesPath: string): InstalledRuntimePaths {
  const root = path.resolve(resourcesPath)
  const recovery = path.join(root, 'recovery')
  return Object.freeze({
    hostEntry: path.join(root, 'runtime-host', 'lib', 'host-entry.js'),
    hostInstallAnchor: path.join(root, 'runtime-host', 'package.json'),
    recoveryHtml: path.join(recovery, 'recovery-view.html'),
    recoveryPreload: path.join(recovery, 'recovery-preload.cjs'),
    compileCachePreload: path.join(recovery, 'host-compile-cache.cjs'),
    loadingHtml: path.join(recovery, 'loading-view.html'),
    compatibilityManifest: path.join(root, 'compatibility.json'),
    trayIcon: path.join(root, 'icons', 'trayTemplate.png'),
  })
}
