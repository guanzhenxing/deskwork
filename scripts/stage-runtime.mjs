#!/usr/bin/env node
// Materialize the self-contained runtime staging tree under release/staging:
//
//   release/staging/
//     app-shell/          tiny asar payload (package.json + main.cjs loader)
//     runtime-host/       pnpm --prod deploy of desktop-launcher (Electron
//                         utilityProcess Host closure, real files)
//     runtime-cli/        pnpm --prod deploy of bundled-cli + official Node
//                         runtime + pinned pnpm + bin/{dsh-native,node,pnpm}
//     native/lease-helper compiled macOS lease helper
//     recovery/           launcher-owned recovery document + preload + script
//     compatibility.json  embedded release manifest (versions/arch/releaseId)
//
// Everything the app executes at runtime comes from this tree: the deployed
// node_modules closures, the downloaded Node/pnpm runtimes (verified against
// official checksums), the native helper, and the recovery assets. Nothing
// resolves through the repository, the pnpm store, or system Node/pnpm.
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { embedRuntimeFacts, generateReleaseManifest } from './generate-compatibility.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staging = path.join(root, 'release', 'staging')
const downloads = path.join(root, 'release', 'downloads')

const requireFromRoot = createRequire(path.join(root, 'package.json'))
const rootManifest = requireFromRoot('./package.json')
const launcherManifest = requireFromRoot('./apps/desktop-launcher/package.json')
let product
// Node >= 22.12 require(esm): read the compiled product facts without
// duplicating PRODUCT.appId/name. Deferred to main(): this module top level
// runs before the workspace build, and product-config/lib only exists after
// it (a clean checkout — like CI — would fail at import time otherwise).
function loadProduct() {
  product = requireFromRoot('./packages/product-config/lib/index.js').PRODUCT
}

const compatibilityDoc = JSON.parse(
  await readFile(path.join(root, 'docs', 'compatibility.json'), 'utf8'),
)
// The bundled Node runtime uses the development baseline recorded in the
// compatibility manifest (single source of truth).
const NODE_BASELINE = compatibilityDoc.node.ci
const PNPM_VERSION = rootManifest.packageManager.replace(/^pnpm@/u, '')
const PNPM_TARBALL_INTEGRITY =
  'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA=='

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error})`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function verifyIntegrity(bytes, expected, label) {
  const algorithm = expected.split('-', 1)[0]
  const digest = createHash(algorithm).update(bytes).digest('base64')
  if (`${algorithm}-${digest}` !== expected) {
    throw new Error(`${label} integrity mismatch: expected ${expected}, got ${algorithm}-${digest}`)
  }
}

async function fetchChecked(url, target, expectedSha256Hex) {
  const cached = await readFile(target).catch(() => undefined)
  if (cached !== undefined && sha256(cached) === expectedSha256Hex) {
    return target
  }
  run('curl', ['-fsSL', '-o', target, url])
  const bytes = await readFile(target)
  if (sha256(bytes) !== expectedSha256Hex) {
    throw new Error(`downloaded ${url} does not match the pinned SHA256`)
  }
  return target
}

async function stageNodeRuntime(arch) {
  const name = `node-v${NODE_BASELINE}-darwin-${arch}`
  // Fetch the official SHASUMS256.txt; the tarball is verified against its
  // entry, so the manifest bytes themselves need no separate pin.
  const sumsPath = path.join(downloads, `SHASUMS256.txt-v${NODE_BASELINE}`)
  if ((await readFile(sumsPath, 'utf8').catch(() => undefined)) === undefined) {
    run('curl', [
      '-fsSL',
      '-o',
      sumsPath,
      `https://nodejs.org/dist/v${NODE_BASELINE}/SHASUMS256.txt`,
    ])
  }
  const sumsText = await readFile(sumsPath, 'utf8')
  const expected = sumsText
    .split('\n')
    .find((line) => line.endsWith(` ${name}.tar.gz`))
    ?.split(/\s+/u)[0]
  if (expected === undefined) throw new Error(`SHASUMS256.txt has no entry for ${name}.tar.gz`)
  const tarball = await fetchChecked(
    `https://nodejs.org/dist/v${NODE_BASELINE}/${name}.tar.gz`,
    path.join(downloads, `${name}.tar.gz`),
    expected,
  )
  const work = await mkdtemp(path.join(tmpdir(), 'dsh-stage-node-'))
  try {
    run('tar', ['-xzf', tarball, '-C', work])
    const extracted = path.join(work, name)
    const target = path.join(staging, 'runtime-cli', 'node')
    // Move the whole official tree (bin/node, include, LICENSE, README...).
    await rm(target, { recursive: true, force: true })
    await rename(extracted, target)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function stagePnpm() {
  const target = path.join(downloads, `pnpm-${PNPM_VERSION}.tgz`)
  const bytes = await readFile(target).catch(() => undefined)
  if (bytes === undefined) {
    run('curl', [
      '-fsSL',
      '-o',
      target,
      `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`,
    ])
  }
  const tarball = await readFile(target)
  verifyIntegrity(tarball, PNPM_TARBALL_INTEGRITY, `pnpm-${PNPM_VERSION}.tgz`)
  const work = await mkdtemp(path.join(tmpdir(), 'dsh-stage-pnpm-'))
  try {
    run('tar', ['-xzf', target, '-C', work])
    const pnpmDir = path.join(staging, 'runtime-cli', 'pnpm')
    await rm(pnpmDir, { recursive: true, force: true })
    // The whole official package: bin/pnpm.mjs imports the dist/ tree.
    await cp(path.join(work, 'package'), pnpmDir, { recursive: true })
    // Stable entry point at pnpm/pnpm.cjs (the layout consumers reference).
    await writeFile(
      path.join(pnpmDir, 'pnpm.cjs'),
      [
        '#!/usr/bin/env node',
        '// Loader: the official pnpm package stays intact under bin/ + dist/.',
        "import('./bin/pnpm.mjs')",
        '',
      ].join('\n'),
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// `injectWorkspacePackages` must NOT live in the workspace file permanently:
// a regular install under that flag rewrites every workspace dependency as a
// file: injection (an inert store copy without build output), which breaks
// tsc/vitest/eslint on any clean checkout. stage-runtime enables it only for
// the deploy commands and restores the workspace file afterwards; the tail of
// main() restores the lockfile and re-links the developer tree.
const WORKSPACE_FILE = path.join(root, 'pnpm-workspace.yaml')
const INJECT_LINE = 'injectWorkspacePackages: true\n'

function withDeployInjection(mutate) {
  const original = readFileSync(WORKSPACE_FILE, 'utf8')
  if (!original.includes('injectWorkspacePackages')) {
    writeFileSync(WORKSPACE_FILE, original + INJECT_LINE)
  }
  try {
    mutate()
  } finally {
    writeFileSync(WORKSPACE_FILE, original)
  }
}

async function deployPackage(filter, target) {
  await rm(target, { recursive: true, force: true })
  withDeployInjection(() => {
    run('corepack', [`pnpm@${PNPM_VERSION}`, '--filter', filter, '--prod', 'deploy', target])
  })
}

async function pruneDevelopmentArtifacts(target) {
  for (const entry of ['src', 'test', 'tsconfig.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await rm(path.join(target, entry), { recursive: true, force: true })
  }
}

async function writeShims() {
  const cliRoot = path.join(staging, 'runtime-cli')
  const bin = path.join(cliRoot, 'bin')
  await mkdir(bin, { recursive: true })
  // The CLI shim executes the bundled Node with argv forwarded verbatim and
  // resolves the staged entry relative to itself — no PATH lookup.
  await writeFile(
    path.join(bin, 'dsh-native'),
    [
      '#!/bin/sh',
      '# dsh-native launcher shim: always runs the bundled Node, never a PATH lookup.',
      'DIR="$(cd "$(dirname "$0")/.." && pwd)"',
      'exec "$DIR/node/bin/node" "$DIR/cli-entry.mjs" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  await writeFile(
    path.join(bin, 'node'),
    [
      '#!/bin/sh',
      '# Bundled Node shim for child processes that spawn `node` by name.',
      'DIR="$(cd "$(dirname "$0")/.." && pwd)"',
      'exec "$DIR/node/bin/node" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  await writeFile(
    path.join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      '# Bundled pnpm shim (self-contained pnpm.cjs from the official tarball).',
      'DIR="$(cd "$(dirname "$0")/.." && pwd)"',
      'exec "$DIR/node/bin/node" "$DIR/pnpm/pnpm.cjs" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // The staged CLI entry runs the deployed bundled-cli with the installed
  // runtime layout (dsh bin from the staged closure, bundled node, native
  // helper, packaged desktop executable).
  await writeFile(
    path.join(cliRoot, 'cli-entry.mjs'),
    [
      "import path from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      "import { runBundledCli } from './lib/index.js'",
      "import { resolvePackagedCliRuntime } from './lib/runtime-paths.js'",
      '',
      'const stagingRoot = path.dirname(fileURLToPath(import.meta.url))',
      'const runtime = resolvePackagedCliRuntime({ stagingRoot })',
      'const code = await runBundledCli(process.argv.slice(2), { runtime })',
      'process.exit(code)',
      '',
    ].join('\n'),
  )
  await chmod(path.join(bin, 'dsh-native'), 0o755)
  await chmod(path.join(bin, 'node'), 0o755)
  await chmod(path.join(bin, 'pnpm'), 0o755)
}

async function writeAppShell(version) {
  const shell = path.join(staging, 'app-shell')
  await mkdir(shell, { recursive: true })
  await writeFile(
    path.join(shell, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-desktop-shell',
        version,
        private: true,
        main: 'main.cjs',
      },
      undefined,
      2,
    )}\n`,
  )
  // CommonJS on purpose: Electron's ESM loader cannot load an ESM entry
  // point from inside the asar archive, and the dynamic import() of the real
  // (module) launcher from CJS works everywhere.
  await writeFile(
    path.join(shell, 'main.cjs'),
    [
      '// Packaged entry stub: the real launcher lives as real files under',
      '// Contents/Resources/runtime-host so the Electron utilityProcess Host',
      '// and its dependency closure never load from inside the asar archive.',
      "const path = require('node:path')",
      "import(path.join(process.resourcesPath, 'runtime-host', 'lib', 'main.js'))",
      '',
    ].join('\n'),
  )
}

/**
 * Closure digest for one staged runtime: the exact versions of the watched
 * DSH singletons plus a SHA-256 over the sorted virtual-store entry names.
 * Deterministic for identical dependency sets; the upgrade precheck compares
 * these instead of trusting version strings alone.
 */
async function closureDigest(closureRoot) {
  const store = path.join(closureRoot, 'node_modules', '.pnpm')
  const entries = (await readdir(store).catch(() => [])).filter((name) => name !== 'node_modules')
  const watched = {}
  for (const name of ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh']) {
    const prefix = `${name.replace('/', '+')}@`
    const versions = entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length).split('_')[0])
    watched[name] = [...new Set(versions)].sort()
  }
  const storeSha256 = sha256(Buffer.from([...entries].sort().join('\n') + '\n', 'utf8'))
  return { singletons: watched, storeEntryCount: entries.length, storeSha256 }
}

async function writeCompatibilityManifest(arch) {
  // The release facts (schema 2) come from the same generator as
  // `generate:compatibility` — staging must never synthesize its own version
  // truth. Runtime facts gathered from the staged tree wrap around that core.
  const releaseManifest = await generateReleaseManifest({ arch })
  const manifest = embedRuntimeFacts(releaseManifest, {
    productExecutableName: product.name,
    appId: product.appId,
    electron: launcherManifest.devDependencies.electron,
    node: NODE_BASELINE,
    pnpm: PNPM_VERSION,
    closureDigest: {
      'runtime-host': await closureDigest(path.join(staging, 'runtime-host')),
      'runtime-cli': await closureDigest(path.join(staging, 'runtime-cli')),
    },
  })
  await writeFile(
    path.join(staging, 'compatibility.json'),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  )
  return { releaseId: releaseManifest.releaseId }
}

async function stageRecoveryAssets() {
  const launcherSrc = path.join(root, 'apps', 'desktop-launcher', 'src')
  const launcherLib = path.join(root, 'apps', 'desktop-launcher', 'lib')
  const target = path.join(staging, 'recovery')
  await mkdir(target, { recursive: true })
  await cp(path.join(launcherSrc, 'recovery-view.html'), path.join(target, 'recovery-view.html'))
  await cp(path.join(launcherSrc, 'recovery-view.js'), path.join(target, 'recovery-view.js'))
  await cp(
    path.join(launcherLib, 'recovery-preload.cjs'),
    path.join(target, 'recovery-preload.cjs'),
  )
  await cp(
    path.join(launcherLib, 'host-compile-cache.cjs'),
    path.join(target, 'host-compile-cache.cjs'),
  )
  await cp(path.join(launcherSrc, 'loading-view.html'), path.join(target, 'loading-view.html'))
}

async function assertIcons() {
  const icons = path.join(root, 'release', 'icons')
  for (const name of ['icon.icns', 'dock-icon.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
    const identity = await stat(path.join(icons, name)).catch(() => undefined)
    if (identity === undefined) {
      throw new Error(
        `missing ${path.join('release', 'icons', name)}; run scripts/build-icons.mjs first`,
      )
    }
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error(`packaged desktop targets macOS (got ${process.platform})`)
  }
  // `pnpm deploy` rewrites the root lockfile and the restore step below puts
  // back exactly what this run started from. A lockfile with uncommitted
  // changes would therefore be silently destroyed — refuse up front rather
  // than discard the user's work (the release chain's clean-tree gate makes
  // the same demand before any staging happens).
  const lockfileStatus = spawnSync('git', ['status', '--porcelain', '--', 'pnpm-lock.yaml'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (lockfileStatus.status !== 0 || lockfileStatus.error !== undefined) {
    throw new Error('stage-runtime: cannot inspect the pnpm-lock.yaml state (git status failed)')
  }
  if (lockfileIsDirty(lockfileStatus.stdout)) {
    throw new Error(
      'stage-runtime: pnpm-lock.yaml has uncommitted changes that staging would overwrite — commit or stash them first',
    )
  }
  const lockfileBefore = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
  const arch = process.arch
  await assertIcons()
  console.log('stage-runtime: building workspace')
  run('corepack', [`pnpm@${PNPM_VERSION}`, 'run', 'build'], { cwd: root })
  run('corepack', [`pnpm@${PNPM_VERSION}`, 'run', 'build:native'], { cwd: root })
  loadProduct()

  let stagingError
  let restoreError
  try {
    await stageAll(arch)
  } catch (error) {
    stagingError = error
  } finally {
    // Restore the lockfile this run started from — also on failure, so a
    // half-finished deploy never leaves the injected-lockfile state
    // behind. The restore itself never throws from the finally block, so
    // it can neither mask nor be masked by the staging error.
    if (process.env.DSH_STAGE_SKIP_RESTORE !== '1') {
      try {
        writeFileSync(path.join(root, 'pnpm-lock.yaml'), lockfileBefore)
        run('corepack', [`pnpm@${PNPM_VERSION}`, 'install', '--frozen-lockfile'], { cwd: root })
        console.log('stage-runtime: restored pnpm-lock.yaml after deploy')
      } catch (error) {
        restoreError = error
      }
    }
  }
  if (stagingError !== undefined) {
    if (restoreError !== undefined) {
      console.error('stage-runtime: lockfile restore also failed:', restoreError)
    }
    throw stagingError
  }
  // A restore failure on an otherwise-successful run must fail the run.
  if (restoreError !== undefined) throw restoreError
}

async function stageAll(arch) {
  await mkdir(staging, { recursive: true })
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await mkdir(downloads, { recursive: true })

  console.log('stage-runtime: deploying host closure')
  await deployPackage('@deskwork/desktop-launcher', path.join(staging, 'runtime-host'))
  await pruneDevelopmentArtifacts(path.join(staging, 'runtime-host'))
  // The recovery bridge must live in the installed Host closure for real
  // Safe Mode boots, but declaring it as a host-supervisor dependency would
  // make it resolvable in the development tree too — the safe-mode smoke's
  // bare-home refusal proof depends on it NOT being resolvable there. So it
  // is materialized into the staged closure only; its own dependency
  // (@deskwork/desktop-contracts, plus the deepseek runtime) is already
  // part of the deployed graph. Copied with the compiled lib + package
  // manifest, exactly like an injected workspace package would be.
  const bridgeSource = path.join(root, 'packages', 'desktop-recovery-bridge')
  const bridgeTarget = path.join(
    staging,
    'runtime-host',
    'node_modules',
    '@deskwork',
    'desktop-recovery-bridge',
  )
  await mkdir(path.dirname(bridgeTarget), { recursive: true })
  for (const entry of ['package.json', 'lib', 'cordis.patch.yml']) {
    await cp(path.join(bridgeSource, entry), path.join(bridgeTarget, entry), {
      recursive: true,
    })
  }
  console.log('stage-runtime: deploying cli closure')
  await deployPackage('@deskwork/bundled-cli', path.join(staging, 'runtime-cli'))
  await pruneDevelopmentArtifacts(path.join(staging, 'runtime-cli'))

  console.log(`stage-runtime: staging official Node v${NODE_BASELINE} (${arch})`)
  await stageNodeRuntime(arch)
  console.log(`stage-runtime: staging pnpm ${PNPM_VERSION}`)
  await stagePnpm()
  await writeShims()

  await mkdir(path.join(staging, 'native'), { recursive: true })
  await cp(
    path.join(root, 'packages', 'home-lease', 'native', '.build', 'lease-helper'),
    path.join(staging, 'native', 'lease-helper'),
  )
  await chmod(path.join(staging, 'native', 'lease-helper'), 0o755)
  await stageRecoveryAssets()
  await writeAppShell(rootManifest.version)
  const { releaseId } = await writeCompatibilityManifest(arch)

  const entries = await readdir(staging)
  console.log(`stage-runtime: staged ${entries.join(', ')} (releaseId ${releaseId})`)
}

/**
 * `git status --porcelain -- pnpm-lock.yaml` output is empty only when the
 * lockfile matches HEAD (and is tracked). Anything else means the restore
 * step would discard uncommitted work.
 */
export function lockfileIsDirty(porcelainOutput) {
  return porcelainOutput.trim() !== ''
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()
