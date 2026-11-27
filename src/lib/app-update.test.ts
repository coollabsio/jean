import { describe, expect, it, vi } from 'vitest'
import {
  fetchGitHubReleaseNotes,
  normalizeReleaseNotes,
  resolveInstallPendingAction,
  shouldOfferUpdateCheck,
} from './app-update'

describe('shouldOfferUpdateCheck', () => {
  it('offers a check when idle', () => {
    expect(
      shouldOfferUpdateCheck({
        pendingUpdateVersion: null,
        updateReadyVersion: null,
        isUpdateInstalling: false,
      })
    ).toBe(true)
  })

  it('skips when user deferred the update (badge showing)', () => {
    expect(
      shouldOfferUpdateCheck({
        pendingUpdateVersion: '1.2.3',
        updateReadyVersion: null,
        isUpdateInstalling: false,
      })
    ).toBe(false)
  })

  it('skips while a download/install is in progress', () => {
    expect(
      shouldOfferUpdateCheck({
        pendingUpdateVersion: '1.2.3',
        updateReadyVersion: null,
        isUpdateInstalling: true,
      })
    ).toBe(false)
  })

  it('skips when update is already installed and waiting for restart (#507)', () => {
    expect(
      shouldOfferUpdateCheck({
        pendingUpdateVersion: null,
        updateReadyVersion: '1.2.3',
        isUpdateInstalling: false,
      })
    ).toBe(false)
  })
})

describe('resolveInstallPendingAction', () => {
  it('relaunches when the package is already ready', () => {
    expect(
      resolveInstallPendingAction({
        updateReadyVersion: '1.2.3',
        isUpdateInstalling: false,
        hasPendingUpdateObject: true,
      })
    ).toBe('relaunch')
  })

  it('prefers relaunch over install even if an update object still exists', () => {
    expect(
      resolveInstallPendingAction({
        updateReadyVersion: '1.2.3',
        isUpdateInstalling: false,
        hasPendingUpdateObject: true,
      })
    ).toBe('relaunch')
  })

  it('is a no-op while installing', () => {
    expect(
      resolveInstallPendingAction({
        updateReadyVersion: null,
        isUpdateInstalling: true,
        hasPendingUpdateObject: true,
      })
    ).toBe('noop')
  })

  it('installs when an update object is available', () => {
    expect(
      resolveInstallPendingAction({
        updateReadyVersion: null,
        isUpdateInstalling: false,
        hasPendingUpdateObject: true,
      })
    ).toBe('install')
  })

  it('is a no-op when nothing is pending', () => {
    expect(
      resolveInstallPendingAction({
        updateReadyVersion: null,
        isUpdateInstalling: false,
        hasPendingUpdateObject: false,
      })
    ).toBe('noop')
  })
})

describe('normalizeReleaseNotes', () => {
  it('trims markdown notes from the update object', () => {
    expect(normalizeReleaseNotes('\n## Features\n- New thing\n ')).toBe(
      '## Features\n- New thing'
    )
  })

  it('returns null for missing, empty, or non-string notes', () => {
    expect(normalizeReleaseNotes(undefined)).toBeNull()
    expect(normalizeReleaseNotes(null)).toBeNull()
    expect(normalizeReleaseNotes('   ')).toBeNull()
    expect(normalizeReleaseNotes(42)).toBeNull()
  })
})

describe('fetchGitHubReleaseNotes', () => {
  it('reads the body of the GitHub release for the version tag', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ body: '## Fixes\n- Bug fixed\n' }))
    )

    await expect(
      fetchGitHubReleaseNotes('1.0.16', fetchMock as typeof fetch)
    ).resolves.toBe('## Fixes\n- Bug fixed')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/coollabsio/jean/releases/tags/v1.0.16',
      expect.anything()
    )
  })

  it('does not double the v prefix', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    await fetchGitHubReleaseNotes('v1.0.16', fetchMock as typeof fetch)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/coollabsio/jean/releases/tags/v1.0.16',
      expect.anything()
    )
  })

  it('returns null when the release is missing', async () => {
    const fetchMock = vi.fn(
      async () => new Response('not found', { status: 404 })
    )
    await expect(
      fetchGitHubReleaseNotes('9.9.9', fetchMock as typeof fetch)
    ).resolves.toBeNull()
  })
})
