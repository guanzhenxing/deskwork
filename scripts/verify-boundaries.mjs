import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/u
const importPattern = /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu
const ignoredDirectories = new Set(['lib', 'node_modules'])

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)))
    else if (entry.isFile() && sourceExtension.test(entry.name)) files.push(target)
  }
  return files
}

function importsOf(source) {
  return [...source.matchAll(importPattern)].map((match) => match[1])
}

export async function findBoundaryViolations(root) {
  const violations = []
  const packageRoot = path.join(root, 'packages')
  for (const file of await sourceFiles(packageRoot)) {
    const relativeFile = path.relative(root, file)
    const imports = importsOf(await readFile(file, 'utf8'))
    for (const specifier of imports) {
      if (specifier === 'electron' || specifier.startsWith('electron/')) {
        violations.push({
          file: path.relative(root, file),
          rule: 'mechanism-no-electron',
          specifier,
        })
      }
      if (specifier.includes('desktop-launcher')) {
        violations.push({
          file: path.relative(root, file),
          rule: 'packages-no-launcher',
          specifier,
        })
      }
      if (specifier === '@deskwork/desktop-contracts') {
        violations.push({
          file: relativeFile,
          rule: 'contracts-capability-subpath',
          specifier,
        })
      }
      if (
        relativeFile.startsWith(path.join('packages', 'host-supervisor', 'src') + path.sep) &&
        specifier.startsWith('@deskwork/desktop-plugin')
      ) {
        violations.push({ file: relativeFile, rule: 'mechanism-no-product-plugin', specifier })
      }
      if (
        relativeFile === path.join('packages', 'host-supervisor', 'src', 'index.ts') &&
        specifier.includes('host-runner')
      ) {
        violations.push({
          file: relativeFile,
          rule: 'supervisor-root-no-host-runner',
          specifier,
        })
      }
      if (
        relativeFile.startsWith(path.join('packages', 'profile-manager', 'src') + path.sep) &&
        specifier === '@deepseek-ai/dsh-app-boot'
      ) {
        violations.push({
          file: relativeFile,
          rule: 'profile-manager-no-dsh-boot',
          specifier,
        })
      }
      if (
        relativeFile.startsWith(path.join('packages', 'product-config', 'src') + path.sep) &&
        specifier.startsWith('@deepseek-ai/')
      ) {
        violations.push({
          file: relativeFile,
          rule: 'product-config-pure',
          specifier,
        })
      }
    }
  }

  const launcherRoot = path.join(root, 'apps', 'desktop-launcher', 'src')
  for (const file of await sourceFiles(launcherRoot)) {
    if (path.basename(file) === 'host-entry.ts') continue
    for (const specifier of importsOf(await readFile(file, 'utf8'))) {
      if (specifier.startsWith('@deepseek-ai/dsh')) {
        violations.push({ file: path.relative(root, file), rule: 'main-no-dsh-runtime', specifier })
      }
    }
  }
  return violations.sort(
    (left, right) => left.file.localeCompare(right.file) || left.rule.localeCompare(right.rule),
  )
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const violations = await findBoundaryViolations(root)
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.rule} (${violation.specifier})`)
    }
    process.exitCode = 1
    return
  }
  console.log('Dependency boundary check passed.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
