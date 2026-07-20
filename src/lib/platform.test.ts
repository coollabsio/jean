import { beforeEach, describe, expect, it, vi } from 'vitest'

const openUrlMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: openUrlMock,
}))

describe('openExternal', () => {
  beforeEach(() => {
    vi.resetModules()
    openUrlMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('opens native/mobile Tauri URLs with the OS default browser opener', async () => {
    openUrlMock.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
      open: vi.fn(),
    })
    vi.stubGlobal('navigator', { platform: 'iPhone' })

    const { openExternal } = await import('./platform')

    await openExternal('https://github.com/owner/repo/issues/123')

    expect(openUrlMock).toHaveBeenCalledWith(
      'https://github.com/owner/repo/issues/123'
    )
    expect(openUrlMock).not.toHaveBeenCalledWith(
      'https://github.com/owner/repo/issues/123',
      'inAppBrowser'
    )
    expect(window.open).not.toHaveBeenCalled()
  })

  it('uses a pre-opened web window only outside native Tauri', async () => {
    const preOpenedWindow = { location: { href: '' } } as Window
    vi.stubGlobal('window', {
      open: vi.fn(),
    })
    vi.stubGlobal('navigator', { platform: 'MacIntel' })

    const { openExternal } = await import('./platform')

    await openExternal(
      'https://github.com/owner/repo/pull/456',
      preOpenedWindow
    )

    expect(preOpenedWindow.location.href).toBe(
      'https://github.com/owner/repo/pull/456'
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})

describe('server platform detection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not derive server platform flags from the browser platform', async () => {
    vi.stubGlobal('window', { open: vi.fn() })
    vi.stubGlobal('navigator', { platform: 'Win32' })

    const { isMacOS, isWindows, isLinux, getServerPlatform } =
      await import('./platform')

    expect(getServerPlatform()).toBe('linux')
    expect(isWindows).toBe(false)
    expect(isMacOS).toBe(false)
    expect(isLinux).toBe(true)
  })

  it('uses the Jean server platform instead of the browser platform when provided', async () => {
    vi.stubGlobal('window', { open: vi.fn() })
    vi.stubGlobal('navigator', { platform: 'Win32' })

    const platform = await import('./platform')

    platform.setServerPlatform('linux')

    expect(platform.getServerPlatform()).toBe('linux')
    expect(platform.isServerWindows()).toBe(false)
    expect(platform.isWindows).toBe(false)

    platform.setServerPlatform('windows')
    expect(platform.isServerWindows()).toBe(true)
    expect(platform.isWindows).toBe(true)
  })

  it('keeps the native client platform separate from a remote server platform', async () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })

    const platform = await import('./platform')

    platform.setServerPlatform('linux')

    expect(platform.isClientMacOS).toBe(true)
    expect(platform.isClientLinux).toBe(false)
    expect(platform.isMacOS).toBe(false)
    expect(platform.isLinux).toBe(true)
  })

  it('formats shortcuts for the native Mac client when the server is Linux', async () => {
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    })
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })

    const platform = await import('./platform')
    platform.setServerPlatform('linux')
    const { formatShortcutDisplay } = await import('@/types/keybindings')

    expect(formatShortcutDisplay('mod+period')).toBe('⌘ + .')
    expect(platform.getModifierSymbol()).toBe('⌘')
  })
})
