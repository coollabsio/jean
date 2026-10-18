import { describe, expect, it } from 'vitest'
import {
  parseServerResourceKey,
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

  it('strips only the local scope from persisted IDs', () => {
    expect(toRawLocalResourceId('local:session-1')).toBe('session-1')
    expect(toRawLocalResourceId('session-1')).toBe('session-1')
    expect(toRawLocalResourceId('remote-a:session-1')).toBe(
      'remote-a:session-1'
    )
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
