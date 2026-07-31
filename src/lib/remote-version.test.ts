import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRemoteAuthUrl,
  checkRemoteVersionCompatibility,
  fetchRemoteServerInfo,
  formatJeanVersionLabel,
  probeRemoteConnectionVersion,
  resetRemoteVersionMismatchNotification,
  warnRemoteVersionMismatch,
} from './remote-version'

const toastWarning = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: toastWarning,
  },
}))

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

describe('remote version helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetRemoteVersionMismatchNotification()
    toastWarning.mockClear()
  })

  it('builds auth URLs with optional tokens', () => {
    expect(buildRemoteAuthUrl('https://jean.example.com/', '')).toBe(
      'https://jean.example.com/api/auth'
    )
    expect(
      buildRemoteAuthUrl('https://jean.example.com', 'secret token')
    ).toBe('https://jean.example.com/api/auth?token=secret+token')
  })

  it('formats version labels', () => {
    expect(formatJeanVersionLabel('0.1.69')).toBe('v0.1.69')
    expect(formatJeanVersionLabel('v0.1.69')).toBe('v0.1.69')
    expect(formatJeanVersionLabel(null)).toBe('version unknown')
  })

  it('treats equal versions as compatible', () => {
    expect(checkRemoteVersionCompatibility('0.1.69', '0.1.69')).toEqual({
      compatible: true,
      localVersion: '0.1.69',
      remoteVersion: '0.1.69',
    })
  })

  it('allows missing remote versions for older servers', () => {
    expect(checkRemoteVersionCompatibility(null, '0.1.69')).toEqual({
      compatible: true,
      localVersion: '0.1.69',
      remoteVersion: null,
    })
  })

  it('marks when the local app is older than the remote', () => {
    const result = checkRemoteVersionCompatibility('0.2.0', '0.1.69')
    expect(result.compatible).toBe(false)
    if (!result.compatible) {
      expect(result.message).toContain('Consider updating this app')
      expect(result.message).toContain('v0.1.69')
      expect(result.message).toContain('v0.2.0')
    }
  })

  it('marks when the local app is newer than the remote', () => {
    const result = checkRemoteVersionCompatibility('0.1.50', '0.1.69')
    expect(result.compatible).toBe(false)
    if (!result.compatible) {
      expect(result.message).toContain('Consider updating the remote Jean server')
    }
  })

  it('fetches remote server version from /api/auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        appVersion: '0.1.70',
        webBuildId: '0.1.70-abc',
      }),
    })

    await expect(
      fetchRemoteServerInfo('https://jean.example.com', 'secret', fetchImpl)
    ).resolves.toEqual({
      ok: true,
      appVersion: '0.1.70',
      webBuildId: '0.1.70-abc',
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://jean.example.com/api/auth?token=secret',
      expect.objectContaining({ signal: expect.anything() })
    )
  })

  it('maps 401 responses to a clear token error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    })

    await expect(
      fetchRemoteServerInfo('https://jean.example.com', 'bad', fetchImpl)
    ).rejects.toThrow('Invalid access token')
  })

  it('probes without blocking on version mismatch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, appVersion: '0.1.70' }),
    })

    await expect(
      probeRemoteConnectionVersion(
        { url: 'https://jean.example.com', token: 'secret' },
        { fetchImpl, localVersion: '0.1.69' }
      )
    ).resolves.toMatchObject({
      appVersion: '0.1.70',
      warning: expect.stringContaining('Consider updating'),
    })
  })

  it('shows a deduped toast warning on mismatch', () => {
    expect(warnRemoteVersionMismatch('9.9.9', '0.1.69')).toBe(true)
    expect(toastWarning).toHaveBeenCalledWith(
      'Jean version mismatch',
      expect.objectContaining({
        description: expect.stringContaining('v9.9.9'),
      })
    )

    expect(warnRemoteVersionMismatch('9.9.9', '0.1.69')).toBe(true)
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })
})
