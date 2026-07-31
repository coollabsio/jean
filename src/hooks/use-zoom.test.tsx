import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPreferences:
  | {
      zoom_level?: number
      mobile_zoom_level?: number
      sync_zoom_levels?: boolean
    }
  | undefined
let mockIsNativeApp = false
let mockIsMobile = false
const mockSetZoom = vi.fn()
const mockMutate = vi.fn()
const mockOnScaleChanged = vi.fn()
let scaleChangedHandler: (() => void) | null = null

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mockPreferences }),
  usePatchPreferences: () => ({ mutate: mockMutate }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mockIsMobile,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => mockIsNativeApp,
}))

vi.mock('@/lib/platform', () => ({
  isClientMacOS: true,
  isMacOS: false,
  getServerPlatform: vi.fn(() => 'mac'),
  isServerWindows: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setZoom: mockSetZoom }),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onScaleChanged: (handler: () => void) => {
      scaleChangedHandler = handler
      mockOnScaleChanged(handler)
      return Promise.resolve(() => {
        scaleChangedHandler = null
      })
    },
  }),
}))

import { useZoom } from './use-zoom'

describe('useZoom', () => {
  beforeEach(() => {
    mockPreferences = { zoom_level: 125 }
    mockIsNativeApp = false
    mockIsMobile = false
    mockSetZoom.mockReset()
    mockSetZoom.mockResolvedValue(undefined)
    mockMutate.mockReset()
    mockOnScaleChanged.mockReset()
    scaleChangedHandler = null
    document.documentElement.style.zoom = ''
    document.documentElement.style.fontSize = ''
    document.documentElement.style.removeProperty('--app-zoom')
  })

  afterEach(() => {
    document.documentElement.style.zoom = ''
    document.documentElement.style.fontSize = ''
    document.documentElement.style.removeProperty('--app-zoom')
  })

  it('applies layout-safe zoom in headless web clients', async () => {
    document.documentElement.style.zoom = '1.5'

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--app-zoom')
      ).toBe('1.25')
    })
    expect(document.documentElement.style.fontSize).toBe('20px')
    expect(document.documentElement.style.zoom).toBe('')
    expect(mockSetZoom).not.toHaveBeenCalled()
  })

  it('uses native webview zoom in the desktop app', async () => {
    mockIsNativeApp = true

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1.25)
    })
    expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe(
      ''
    )
    expect(document.documentElement.style.fontSize).toBe('')
  })

  it('re-applies native zoom (bounce through 1) when display scale changes', async () => {
    mockIsNativeApp = true
    mockPreferences = { zoom_level: 90 }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(0.9)
    })
    await waitFor(() => {
      expect(mockOnScaleChanged).toHaveBeenCalled()
    })

    mockSetZoom.mockClear()
    scaleChangedHandler?.()

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1)
      expect(mockSetZoom).toHaveBeenCalledWith(0.9)
    })
  })

  it('does not bounce through 1 when already at 100% zoom on scale change', async () => {
    mockIsNativeApp = true
    mockPreferences = { zoom_level: 100 }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1)
    })
    await waitFor(() => {
      expect(mockOnScaleChanged).toHaveBeenCalled()
    })

    mockSetZoom.mockClear()
    scaleChangedHandler?.()

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1)
    })
    expect(mockSetZoom).toHaveBeenCalledTimes(1)
  })

  it('uses the separate mobile zoom when syncing is disabled', async () => {
    mockIsMobile = true
    mockPreferences = {
      zoom_level: 100,
      mobile_zoom_level: 150,
      sync_zoom_levels: false,
    }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(document.documentElement.style.fontSize).toBe('24px')
    })
  })

  it('uses desktop zoom on mobile when syncing is enabled', async () => {
    mockIsMobile = true
    mockPreferences = {
      zoom_level: 110,
      mobile_zoom_level: 150,
      sync_zoom_levels: true,
    }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(document.documentElement.style.fontSize).toBe('17.6px')
    })
  })

  it('uses the Mac client modifier when connected to a non-Mac server', () => {
    mockIsNativeApp = true
    mockPreferences = {
      zoom_level: 125,
      mobile_zoom_level: 125,
      sync_zoom_levels: true,
    }
    renderHook(() => useZoom())

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', metaKey: true, bubbles: true })
    )

    expect(mockMutate).toHaveBeenCalledWith({
      zoom_level: 150,
      mobile_zoom_level: 150,
    })
  })

  it('uses Control for zoom in a Mac web client', () => {
    mockPreferences = { zoom_level: 125 }
    renderHook(() => useZoom())

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true })
    )

    expect(mockMutate).toHaveBeenCalledWith({
      zoom_level: 150,
      mobile_zoom_level: 150,
    })
  })
})
