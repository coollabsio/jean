import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearClientZoomForTests, writeClientZoom } from '@/lib/client-zoom'

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
const mockOnScaleChanged = vi.fn()
interface ScaleChangedEvent {
  payload: { scaleFactor: number }
}
let scaleChangedHandler: ((event: ScaleChangedEvent) => void) | null = null

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mockPreferences }),
  usePatchPreferences: () => ({ mutate: vi.fn() }),
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
  getCurrentWebview: () => ({
    setZoom: (...args: unknown[]) => mockSetZoom(...args),
  }),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onScaleChanged: (handler: (event: ScaleChangedEvent) => void) => {
      scaleChangedHandler = handler
      mockOnScaleChanged(handler)
      return Promise.resolve(() => {
        scaleChangedHandler = null
      })
    },
  }),
}))

// Ensure dynamic imports hit the same mocks (vitest isolates some ESM paths).
vi.mock('@tauri-apps/api/webview.js', () => ({
  getCurrentWebview: () => ({
    setZoom: (...args: unknown[]) => mockSetZoom(...args),
  }),
}))

vi.mock('@tauri-apps/api/window.js', () => ({
  getCurrentWindow: () => ({
    onScaleChanged: (handler: (event: ScaleChangedEvent) => void) => {
      scaleChangedHandler = handler
      mockOnScaleChanged(handler)
      return Promise.resolve(() => {
        scaleChangedHandler = null
      })
    },
  }),
}))

import { DISPLAY_SCALE_ZOOM_SETTLE_MS, useZoom } from './use-zoom'

describe('useZoom', () => {
  beforeEach(() => {
    clearClientZoomForTests()
    mockPreferences = { zoom_level: 125 }
    mockIsNativeApp = false
    mockIsMobile = false
    mockSetZoom.mockReset()
    mockSetZoom.mockResolvedValue(undefined)
    mockOnScaleChanged.mockReset()
    scaleChangedHandler = null
    document.documentElement.style.zoom = ''
    document.documentElement.style.fontSize = ''
    document.documentElement.style.removeProperty('--app-zoom')
  })

  afterEach(() => {
    vi.useRealTimers()
    clearClientZoomForTests()
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

  it('does not re-apply native zoom at 100% when display scale changes', async () => {
    mockIsNativeApp = true
    mockPreferences = { zoom_level: 100 }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1)
      expect(mockOnScaleChanged).toHaveBeenCalledOnce()
    })

    mockSetZoom.mockClear()
    scaleChangedHandler?.({ payload: { scaleFactor: 2 } })

    expect(mockSetZoom).not.toHaveBeenCalled()
  })

  it('refreshes a custom native zoom once when display scale changes', async () => {
    mockIsNativeApp = true
    mockPreferences = { zoom_level: 90 }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockOnScaleChanged).toHaveBeenCalledOnce()
    })
    mockSetZoom.mockClear()

    scaleChangedHandler?.({ payload: { scaleFactor: 2 } })

    await waitFor(() => {
      expect(mockSetZoom.mock.calls).toEqual([[1], [0.9]])
    })
  })

  it('ignores scale events caused while refreshing custom native zoom', async () => {
    mockIsNativeApp = true
    mockPreferences = { zoom_level: 90 }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockOnScaleChanged).toHaveBeenCalledOnce()
    })
    mockSetZoom.mockClear()
    mockSetZoom.mockImplementation(async zoom => {
      if (zoom === 1) {
        scaleChangedHandler?.({ payload: { scaleFactor: 1.8 } })
      }
    })

    scaleChangedHandler?.({ payload: { scaleFactor: 2 } })

    await waitFor(() => {
      expect(mockSetZoom.mock.calls).toEqual([[1], [0.9]])
    })
  })

  it('ignores delayed scale side-effects after the zoom bounce settles', async () => {
    vi.useFakeTimers()
    mockIsNativeApp = true
    mockPreferences = { zoom_level: 90 }

    renderHook(() => useZoom())

    await vi.runAllTimersAsync()
    expect(mockOnScaleChanged).toHaveBeenCalledOnce()
    mockSetZoom.mockClear()

    mockSetZoom.mockImplementation(async zoom => {
      if (zoom === 0.9) {
        // Side-effect after the bounce, still inside the settle window.
        scaleChangedHandler?.({ payload: { scaleFactor: 1.75 } })
      }
    })

    scaleChangedHandler?.({ payload: { scaleFactor: 2 } })
    await vi.runAllTimersAsync()

    expect(mockSetZoom.mock.calls).toEqual([[1], [0.9]])

    // Settle window ends; absorbed scale must not re-fire.
    await vi.advanceTimersByTimeAsync(DISPLAY_SCALE_ZOOM_SETTLE_MS)
    scaleChangedHandler?.({ payload: { scaleFactor: 1.75 } })
    expect(mockSetZoom).toHaveBeenCalledTimes(2)

    // A real later monitor change still refreshes once.
    scaleChangedHandler?.({ payload: { scaleFactor: 1 } })
    await vi.runAllTimersAsync()
    expect(mockSetZoom.mock.calls).toEqual([[1], [0.9], [1], [0.9]])
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

  it('uses the Mac client modifier when connected to a non-Mac server', async () => {
    mockIsNativeApp = true
    mockPreferences = {
      zoom_level: 125,
      mobile_zoom_level: 125,
      sync_zoom_levels: true,
    }
    renderHook(() => useZoom())

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1.25)
    })

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', metaKey: true, bubbles: true })
    )

    await waitFor(() => {
      expect(mockSetZoom).toHaveBeenCalledWith(1.5)
    })
  })

  it('uses Control for zoom in a Mac web client', async () => {
    mockPreferences = { zoom_level: 125 }
    renderHook(() => useZoom())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--app-zoom')
      ).toBe('1.25')
    })

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true })
    )

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--app-zoom')
      ).toBe('1.5')
    })
  })

  it('keeps client zoom when server preferences change after seed', async () => {
    writeClientZoom({
      zoom_level: 150,
      mobile_zoom_level: 150,
      sync_zoom_levels: true,
    })
    mockPreferences = { zoom_level: 90 }

    renderHook(() => useZoom())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--app-zoom')
      ).toBe('1.5')
    })
  })
})
