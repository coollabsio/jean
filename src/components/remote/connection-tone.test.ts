import { describe, expect, it } from 'vitest'

import { getLocalJeanVersion } from '@/lib/remote-version'
import { connectionTone } from './connection-tone'

const LOCAL = getLocalJeanVersion()

describe('connectionTone', () => {
  it('is success when the server answers with a matching version', () => {
    expect(connectionTone({ status: 'ready', version: LOCAL })).toBe('success')
  })

  it('is warning when the server version differs', () => {
    expect(connectionTone({ status: 'ready', version: '0.0.1' })).toBe(
      'warning'
    )
  })

  it('is destructive when the server is unreachable', () => {
    expect(connectionTone({ status: 'error', message: 'refused' })).toBe(
      'destructive'
    )
  })

  it('is destructive when the SSH tunnel failed, even with a cached version', () => {
    expect(connectionTone({ status: 'ready', version: LOCAL }, 'failed')).toBe(
      'destructive'
    )
  })

  it('is muted while checking or reconnecting', () => {
    expect(connectionTone(undefined)).toBe('muted')
    expect(connectionTone({ status: 'loading' })).toBe('muted')
    expect(
      connectionTone({ status: 'ready', version: LOCAL }, 'reconnecting')
    ).toBe('muted')
  })

  it('is muted when the SSH tunnel stopped, even with a cached version', () => {
    expect(connectionTone({ status: 'ready', version: LOCAL }, 'stopped')).toBe(
      'muted'
    )
    expect(connectionTone({ status: 'ready', version: LOCAL }, 'ready')).toBe(
      'success'
    )
  })
})
