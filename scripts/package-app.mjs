#!/usr/bin/env node
// Invoke the pinned electron-builder against the staged runtime tree.
//
//   node scripts/package-app.mjs --dir   → unpacked .app (fast local iterate)
//   node scripts/package-app.mjs --dmg   → DMG candidate
//
// The target is also steered by DSH_PACKAGE_TARGET for the config file; the
// argument form keeps the npm scripts explicit.
import { spawnSync } from 'node:child_process'
import { access, constants, mkdir, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builderCli = path.join(root, 'node_modules', '.bin', 'electron-builder')
const config = path.join(root, 'build', 'electron-builder.config.cjs')

const wantsDmg = process.argv.includes('--dmg')
const mode = wantsDmg ? 'dmg' : process.argv.includes('--dir') ? 'dir' : undefined
if (mode === undefined) {
  throw new Error('pass either --dir or --dmg')
}

async function assertStaged() {
  const required = [
    'app-shell/package.json',
    'app-shell/main.cjs',
    'runtime-host/lib/main.js',
    'runtime-host/lib/host-entry.js',
    'runtime-cli/bin/dsh-native',
    'runtime-cli/node/bin/node',
    'recovery/recovery-view.html',
    'compatibility.json',
  ]
  for (const relative of required) {
    await access(path.join(root, 'release', 'staging', relative), constants.F_OK)
  }
}

await assertStaged()

// electron-builder skips signing with `identity: null`, but flipping the
// Electron fuses invalidates the upstream ad-hoc signature and macOS then
// kills the app on exec. Re-apply an ad-hoc signature: this changes nothing
// about the honest "no Developer ID / not notarized" status and touches no
// Gatekeeper setting.
//
// Build order matters for the DMG: the fuses run inside every builder pass,
// so a DMG target would seal an unsigned app before our re-signing step
// could see it. Therefore the DMG is always produced from the already
// re-signed --dir build via --prepackaged.
const productName = createRequire(path.join(root, 'package.json'))(
  './packages/product-config/lib/index.js',
).PRODUCT.name
const appBundle = path.join(root, 'release', 'dist', `mac-${process.arch}`, `${productName}.app`)

function runBuilder(args) {
  const result = spawnSync(builderCli, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DSH_PACKAGE_TARGET: 'dir' },
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`electron-builder failed with status ${result.status ?? result.error}`)
  }
}

function signAdHoc(bundle) {
  const resign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', bundle], {
    stdio: 'inherit',
  })
  if (resign.error !== undefined || resign.status !== 0) {
    throw new Error(`ad-hoc re-signing failed (${resign.status ?? resign.error})`)
  }
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], {
    encoding: 'utf8',
  })
  if (verify.status !== 0) {
    throw new Error(`ad-hoc signature verification failed: ${verify.stderr}`)
  }
}

runBuilder(['--config', config, '--mac', 'dir'])
signAdHoc(appBundle)
if (mode === 'dmg') {
  // Seal the re-signed .app into a DMG directly. electron-builder's dmg
  // target re-runs the fuses (invalidating the signature we just applied)
  // and its --prepackaged mode mangles the afterPack resources; a plain
  // hdiutil UDZO image is deterministic and exactly what the smoke installs.
  const layout = path.join(root, 'release', 'staging', 'dmg-layout')
  await rm(layout, { recursive: true, force: true })
  await mkdir(layout, { recursive: true })
  try {
    spawnSync('/usr/bin/ditto', [appBundle, path.join(layout, `${productName}.app`)], {
      stdio: 'inherit',
    })
    await symlink('/Applications', path.join(layout, 'Applications'))
    const version = createRequire(path.join(root, 'package.json'))('./package.json').version
    const target = path.join(
      root,
      'release',
      'dist',
      `${productName}-${version}-${process.arch}.dmg`,
    )
    await rm(target, { force: true })
    const create = spawnSync(
      'hdiutil',
      [
        'create',
        '-volname',
        productName,
        '-fs',
        'HFS+',
        '-format',
        'UDZO',
        '-srcfolder',
        layout,
        '-o',
        target,
      ],
      { stdio: 'inherit' },
    )
    if (create.error !== undefined || create.status !== 0) {
      throw new Error(`hdiutil create failed (${create.status ?? create.error})`)
    }
  } finally {
    await rm(layout, { recursive: true, force: true })
  }
}

console.log(`package-app: ${mode} build finished under release/dist (ad-hoc signed)`)
