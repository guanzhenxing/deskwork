import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assertRealDirectory, syncDirectory, writeAtomicDurable } from '../src/index.js'

const roots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-durable-fs-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('writeAtomicDurable', () => {
  it('writes the bytes and leaves no temporary behind', async () => {
    const root = await scratch()
    const file = path.join(root, 'state.json')
    await writeAtomicDurable(file, Buffer.from('{"a":1}\n', 'utf8'))
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n')
    expect(await readdir(root)).toEqual(['state.json'])
  })

  it('replaces an existing file atomically and narrows the mode', async () => {
    const root = await scratch()
    const file = path.join(root, 'state.json')
    await writeFile(file, 'old', { mode: 0o644 })
    await writeAtomicDurable(file, Buffer.from('new', 'utf8'))
    expect(await readFile(file, 'utf8')).toBe('new')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('creates missing parent directories', async () => {
    const root = await scratch()
    const file = path.join(root, 'nested', 'deeper', 'state.json')
    await writeAtomicDurable(file, Buffer.from('value', 'utf8'))
    expect(await readFile(file, 'utf8')).toBe('value')
  })

  it('rejects when the target path is a directory and cleans its temp file', async () => {
    const root = await scratch()
    const file = path.join(root, 'state.json')
    await mkdir(file)
    await expect(writeAtomicDurable(file, Buffer.from('x', 'utf8'))).rejects.toBeTruthy()
    expect(await readdir(root)).toEqual(['state.json'])
  })

  it('does not follow a symlink planted at the target path', async () => {
    const root = await scratch()
    const target = path.join(root, 'elsewhere.json')
    await writeFile(target, 'original')
    const file = path.join(root, 'state.json')
    await symlink(target, file)
    await writeAtomicDurable(file, Buffer.from('replaced', 'utf8'))
    // The rename replaces the link itself; the file it pointed at is untouched.
    expect(await readFile(target, 'utf8')).toBe('original')
    expect(await readFile(file, 'utf8')).toBe('replaced')
  })
})

describe('assertRealDirectory', () => {
  it('reports a missing directory without creating it', async () => {
    const root = await scratch()
    expect(await assertRealDirectory(path.join(root, 'absent'), 'profile')).toBe(false)
  })

  it('accepts a real directory and refuses a symlink', async () => {
    const root = await scratch()
    const real = path.join(root, 'real')
    await mkdir(real)
    expect(await assertRealDirectory(real, 'profile')).toBe(true)
    const link = path.join(root, 'link')
    await symlink(real, link)
    await expect(assertRealDirectory(link, 'profile')).rejects.toThrow(/symlink/u)
  })
})

describe('syncDirectory', () => {
  it('fsyncs an existing directory', async () => {
    const root = await scratch()
    await expect(syncDirectory(root)).resolves.toBeUndefined()
  })
})
