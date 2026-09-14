import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addRemoteConnection,
  clearConnectionSwitch,
  getActiveConnectionId,
  getActiveRemoteConnection,
  getEnabledServerConnections,
  getRemoteConnections,
  isConnectionSwitchPending,
  markConnectionSwitch,
  parseRemoteConnectionInput,
  removeRemoteConnection,
  selectConnection,
  setRemoteConnectionEnabled,
  setLocalDashboardEnabled,
  selectLocalConnectionForNativeClient,
  getLocalDashboardEnabled,
  subscribeRemoteConnections,
  updateRemoteConnection,
} from './remote-connections'

describe('remote connections', () => {
  beforeEach(() => {
    for (const connection of getRemoteConnections()) {
      removeRemoteConnection(connection.id)
    }
    localStorage.clear()
    sessionStorage.clear()
    setLocalDashboardEnabled(true)
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

  it('enables new connections by default and can exclude them', () => {
    const remote = addRemoteConnection({
      name: 'Build server',
      url: 'https://jean.example.com',
      token: 'token',
    })

    expect(remote.enabled).toBe(true)
    expect(getEnabledServerConnections()).toEqual([remote])

    selectConnection(remote.id)
    setRemoteConnectionEnabled(remote.id, false)

    expect(getEnabledServerConnections()).toEqual([])
    expect(getActiveConnectionId()).toBe('local')
  })

  it('can exclude local from the dashboard without changing selection', () => {
    selectConnection('local')

    setLocalDashboardEnabled(false)

    expect(getLocalDashboardEnabled()).toBe(false)
    expect(getActiveConnectionId()).toBe('local')
  })

  it('migrates the native client backend to Local but leaves Web Access unchanged', () => {
    const remote = addRemoteConnection({
      name: 'Build server',
      url: 'https://jean.example.com',
      token: 'token',
    })
    selectConnection(remote.id)

    selectLocalConnectionForNativeClient(false)
    expect(getActiveConnectionId()).toBe(remote.id)

    selectLocalConnectionForNativeClient(true)
    expect(getActiveConnectionId()).toBe('local')
  })

  it('keeps enabled state when editing a connection', () => {
    const remote = addRemoteConnection({
      name: 'Build server',
      url: 'https://jean.example.com',
      token: 'token',
    })
    setRemoteConnectionEnabled(remote.id, false)

    const updated = updateRemoteConnection(remote.id, {
      name: 'Renamed server',
      url: remote.url,
      token: remote.token,
    })

    expect(updated.enabled).toBe(false)
  })

  it('notifies an imperative connection subscriber', () => {
    const subscriber = vi.fn()
    const unsubscribe = subscribeRemoteConnections(subscriber)

    const remote = addRemoteConnection({
      name: 'Build server',
      url: 'https://jean.example.com',
      token: 'token',
    })

    expect(subscriber).toHaveBeenCalledOnce()
    unsubscribe()
    removeRemoteConnection(remote.id)
    expect(subscriber).toHaveBeenCalledOnce()
  })

  it('marks an intentional switch so unload cleanup can be skipped', () => {
    markConnectionSwitch()
    expect(isConnectionSwitchPending()).toBe(true)

    clearConnectionSwitch()
    expect(isConnectionSwitchPending()).toBe(false)
  })

  it('persists optional SSH fields for remote editor open', () => {
    const remote = addRemoteConnection({
      name: 'Build server',
      url: 'https://jean.example.com?token=first',
      token: '',
      sshUser: 'ubuntu',
      sshHost: '192.168.1.50',
      sshPort: 2222,
    })

    expect(remote).toMatchObject({
      sshUser: 'ubuntu',
      sshHost: '192.168.1.50',
      sshPort: 2222,
    })
    expect(getRemoteConnections()[0]).toMatchObject({
      sshUser: 'ubuntu',
      sshHost: '192.168.1.50',
      sshPort: 2222,
    })

    const updated = updateRemoteConnection(remote.id, {
      name: remote.name,
      url: remote.url,
      token: 'second',
      sshUser: 'deploy',
      sshHost: '192.168.1.50',
      sshPort: 22,
    })
    expect(updated.sshUser).toBe('deploy')
    // Default SSH port is not stored.
    expect(updated.sshPort).toBeUndefined()
  })
})
