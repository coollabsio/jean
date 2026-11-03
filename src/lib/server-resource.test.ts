import { describe, expect, it } from 'vitest'
import {
  isSameServerResource,
  parseServerResourceKey,
  scopeLikeOwner,
  serverResourceKey,
  toRawLocalResourceId,
  withServerId,
} from './server-resource'

describe('server resource identity', () => {
  it('creates a collision-safe composite key', () => {
    expect(
      serverResourceKey({ serverId: 'remote:a', resourceId: 'project/1' })
    ).toBe('remote%3Aa:project%2F1')
  })

  it('scopes a raw id like the remote resource that names it', () => {
    expect(scopeLikeOwner('remote-a:session-1', 'session-2')).toBe(
      'remote-a:session-2'
    )
    expect(scopeLikeOwner('session-1', 'session-2')).toBe('session-2')
    expect(scopeLikeOwner('local:session-1', 'session-2')).toBe('session-2')
  })

  it('strips only the local scope from persisted IDs', () => {
    expect(toRawLocalResourceId('local:session-1')).toBe('session-1')
    expect(toRawLocalResourceId('session-1')).toBe('session-1')
    expect(toRawLocalResourceId('remote-a:session-1')).toBe(
      'remote-a:session-1'
    )
  })

  it('compares resource owners, treating raw ids as local', () => {
    expect(isSameServerResource('s1', 'local:s2')).toBe(true)
    expect(isSameServerResource('remote-a:s1', 'remote-a:s2')).toBe(true)
    expect(isSameServerResource('s1', 'remote-a:s2')).toBe(false)
    expect(isSameServerResource('remote-a:s1', 'remote-b:s2')).toBe(false)
  })

  it('parses a composite key', () => {
    expect(parseServerResourceKey('remote%3Aa:project%2F1')).toEqual({
      serverId: 'remote:a',
      resourceId: 'project/1',
    })
  })

  it.each(['', ':resource', 'server:', 'server', '%:resource'])(
    'rejects invalid key %j',
    key => {
      expect(parseServerResourceKey(key)).toBeNull()
    }
  )

  it('adds server ownership without changing the input', () => {
    const project = { id: 'p1', name: 'Jean' }

    expect(withServerId('local', project)).toEqual({
      id: 'p1',
      name: 'Jean',
      serverId: 'local',
    })
    expect(project).toEqual({ id: 'p1', name: 'Jean' })
  })
})
