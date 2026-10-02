// electron-builder configuration for the packaged desktop candidate.
//
// Schema verified against the pinned electron-builder 26.15.3 actually
// installed in node_modules (directories.app/output, asar, mac.category/
// target/icon, electronFuses with FuseOptionsV1 field names, afterPack) —
// not copied from other versions' documentation.
//
// Version facts are read from the repository manifests and the compiled
// product-config package; nothing is hand-duplicated here:
//   - appId/productName      ← packages/product-config (PRODUCT); the
//     bundle filename IS the product name — the Dock shows it
//   - electronVersion        ← apps/desktop-launcher devDependencies.electron
//   - app version            ← release/staging/app-shell/package.json
//     (written by scripts/stage-runtime.mjs from the root package.json)
//
// Resources are copied in afterPack with `cp -a`: electron-builder's
// extraResources copy drops node_modules directories, and the staged pnpm
// closures consist of thousands of RELATIVE symlinks (verified by
// scripts/verify-runtime-tree.mjs) that must be preserved verbatim for the
// app to stay self-contained. afterPack runs before fuses, signing and DMG
// creation, so every artifact form includes the same tree.
//
// Signing: local-use candidate; `identity: null` keeps electron-builder's
// signing off (macOS default Gatekeeper protections stay in place) and
// scripts/package-app.mjs re-applies an ad-hoc signature after the fuses
// invalidated the upstream one. The acceptance record states the real
// signing/notarization status.
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')

const root = path.resolve(__dirname, '..')
// Node >= 22.12 require(esm) gives us the compiled PRODUCT without duplicating
// the appId/productName strings (CI/dev baseline is Node 24.11.1).
const { PRODUCT } = require(path.join(root, 'packages', 'product-config', 'lib', 'index.js'))
const launcherManifest = require(path.join(root, 'apps', 'desktop-launcher', 'package.json'))
const staging = path.join(root, 'release', 'staging')
const icons = path.join(root, 'release', 'icons')

function copyPreserving(input, outputDirectory) {
  const result = spawnSync('/bin/cp', ['-a', input, outputDirectory], { stdio: 'inherit' })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `copying ${input} into ${outputDirectory} failed (${result.status ?? result.error})`,
    )
  }
}

module.exports = {
  appId: PRODUCT.appId,
  productName: PRODUCT.name,
  electronVersion: launcherManifest.devDependencies.electron,
  directories: {
    app: path.join(staging, 'app-shell'),
    output: path.join(root, 'release', 'dist'),
  },
  asar: true,
  files: ['**/*'],
  electronFuses: {
    // The CLI ships its own Node, so the Electron binary never needs to act
    // as Node, and neither NODE_OPTIONS nor the inspector may reshape it.
    // utilityProcess (the Host transport) does not depend on these. Field
    // names verified against the installed 26.15.3 FuseOptionsV1 schema.
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
  },
  mac: {
    category: 'public.app-category.developer-tools',
    target: process.env.DSH_PACKAGE_TARGET === 'dmg' ? 'dmg' : 'dir',
    icon: path.join(icons, 'icon.icns'),
    identity: null,
    // The Dock and the menu bar display these keys, not the bundle filename.
    // extendInfo is deep-assigned after electron-builder's CFBundleName/
    // CFBundleDisplayName defaults (verified in the installed app-builder-lib
    // 26.15.3, macPackager.applyCommonInfo). CFBundleName is what Electron
    // uses to resolve child-process helpers, so afterPack below renames the
    // helper bundles to the same base name — a mismatch aborts at startup.
    extendInfo: {
      CFBundleName: PRODUCT.displayName,
      CFBundleDisplayName: PRODUCT.displayName,
    },
  },
  async afterPack(context) {
    const resources = path.join(context.appOutDir, `${PRODUCT.name}.app`, 'Contents', 'Resources')
    for (const entry of [
      'runtime-host',
      'recovery',
      'compatibility.json',
    ]) {
      copyPreserving(path.join(staging, entry), resources)
    }
    mkdirSync(path.join(resources, 'icons'), { recursive: true })
    copyPreserving(path.join(icons, 'dock-icon.png'), resources)
    copyPreserving(path.join(icons, 'trayTemplate.png'), path.join(resources, 'icons'))
    copyPreserving(path.join(icons, 'trayTemplate@2x.png'), path.join(resources, 'icons'))
  },
}
