import { describe, expect, it } from 'vitest'

import { createHomeSession } from '../src/home-session.js'

describe('createHomeSession', () => {
  it('carries the home, a fresh generation and the profile', () => {
    const session = createHomeSession({ home: '/tmp/home', profile: 'deskwork' })
    expect(session.home).toBe('/tmp/home')
    expect(session.profile).toBe('deskwork')
    expect(session.generation).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('gives every session a distinct generation', () => {
    const first = createHomeSession({ home: '/tmp/home', profile: 'deskwork' })
    const second = createHomeSession({ home: '/tmp/home', profile: 'deskwork' })
    expect(first.generation).not.toBe(second.generation)
  })

  it('accepts a fixed generation for tests', () => {
    const session = createHomeSession({
      home: '/tmp/home',
      profile: 'deskwork',
      generation: 'fixed-generation',
    })
    expect(session.generation).toBe('fixed-generation')
    expect(Object.isFrozen(session)).toBe(true)
  })

  it('refuses a blank home or profile', () => {
    expect(() => createHomeSession({ home: '  ', profile: 'deskwork' })).toThrow(/explicit home/u)
    expect(() => createHomeSession({ home: '/tmp/home', profile: ' ' })).toThrow(
      /explicit profile/u,
    )
  })
})
