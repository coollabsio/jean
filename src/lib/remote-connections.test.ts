import { beforeEach, describe, expect, it } from 'vitest'
import {
  addRemoteConnection,
  clearConnectionSwitch,
  getActiveConnectionId,
  getActiveRemoteConnection,
  getRemoteConnections,
  isConnectionSwitchPending,
  markConnectionSwitch,
  parseRemoteConnectionInput,
  removeRemoteConnection,
  selectConnection,
  updateRemoteConnection,
} from './remote-connections'

describe('remote connections', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('extracts a token from a complete Web Access URL', () => {
    expect(
      parseRemoteConnectionInput('https://jean.example.com/?token=secret', '')
    ).toEqual({ url: 'https://jean.example.com', token: 'secret' })
  })

  it('accepts a separate token and normalizes the URL', () => {
    expect(
      parseRemoteConnectionInput('http://server.local:3456///', ' token ')
    ).toEqual({ url: 'http://server.local:3456', token: 'token' })
  })

  it('rejects unsupported URL schemes', () => {
    expect(() => parseRemoteConnectionInput('ftp://server', 'token')).toThrow(
      'HTTP or HTTPS'
    )
  })

  it('persists CRUD operations and the active selection', () => {
    const remote = addRemoteConnection({
      name: 'Build server',
      url: 'https://jean.example.com?token=first',
      token: '',
    })

    expect(getRemoteConnections()).toEqual([remote])

    selectConnection(remote.id)
    expect(getActiveConnectionId()).toBe(remote.id)
    expect(getActiveRemoteConnection()).toEqual(remote)

    const updated = updateRemoteConnection(remote.id, {
      name: 'Production',
      url: remote.url,
      token: 'second',
    })
    expect(getRemoteConnections()).toEqual([updated])

    removeRemoteConnection(remote.id)
    expect(getRemoteConnections()).toEqual([])
    expect(getActiveConnectionId()).toBe('local')
  })

  it('marks an intentional switch so unload cleanup can be skipped', () => {
    markConnectionSwitch()
    expect(isConnectionSwitchPending()).toBe(true)

    clearConnectionSwitch()
    expect(isConnectionSwitchPending()).toBe(false)
  })
})
