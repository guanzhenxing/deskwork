/**
 * Read-only product identity shared by every desktop entrypoint. This package
 * intentionally has no dependencies: it must stay importable from Electron
 * Main and tests without dragging in Electron or any DSH runtime.
 */
export * from './home-paths.js'

export const PRODUCT = Object.freeze({
  // The .app bundle filename, the executable, the helpers and every
  // system-facing name. The Dock hover of a running app shows the bundle
  // filename, so this is the name users see.
  name: 'Deskwork',
  // Pinned directory name: user data lives in
  // ~/Library/Application Support/<dataDirectoryName> and must never follow
  // display renames (Electron derives the default from app.name, so the
  // launcher pins userData to this value instead).
  dataDirectoryName: 'Deskwork',
  // Same value as `name`; kept as the explicit display identity for UI
  // labels so a future split (if ever needed) has one place to change.
  displayName: 'Deskwork',
  appId: 'local.deskwork.app',
  binName: 'dsh-desktop',
  defaultProfileName: 'deskwork',
  settingsNamespace: 'dsh-native-shell',
  defaultPort: 0,
  rendererPartition: 'persist:dsh-desktop-renderer',
})
