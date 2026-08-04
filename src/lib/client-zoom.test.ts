import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIENT_ZOOM_STORAGE_KEY,
  clearClientZoomForTests,
  clampZoomLevel,
  defaultClientZoomSettings,
  readClientZoom,
  resolveClientZoom,
  writeClientZoom,
} from './client-zoom'

describe('client-zoom', () => {
  beforeEach(() => {
    clearClientZoomForTests()
    vi.mocked(window.localStorage.getItem).mockReset()
    vi.mocked(window.localStorage.setItem).mockReset()
    vi.mocked(window.localStorage.removeItem).mockReset()
    vi.mocked(window.localStorage.getItem).mockReturnValue(null)
  })

  afterEach(() => {
    clearClientZoomForTests()
  })

  it('clamps zoom to the supported range', () => {
    expect(clampZoomLevel(10)).toBe(50)
    expect(clampZoomLevel(300)).toBe(200)
    expect(clampZoomLevel(125.4)).toBe(125)
    expect(clampZoomLevel(Number.NaN)).toBe(100)
  })

  it('writes and reads client-local zoom without shared backend state', () => {
    expect(readClientZoom()).toBeNull()

    const written = writeClientZoom({
      zoom_level: 125,
      mobile_zoom_level: 150,
      sync_zoom_levels: false,
    })

    expect(written).toEqual({
      zoom_level: 125,
      mobile_zoom_level: 150,
      sync_zoom_levels: false,
    })
    expect(readClientZoom()).toEqual(written)
    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      CLIENT_ZOOM_STORAGE_KEY,
      expect.stringContaining('"zoom_level":125')
    )
  })

  it('seeds from server preferences only when client has no stored zoom', () => {
    const seeded = resolveClientZoom({
      zoom_level: 90,
      mobile_zoom_level: 110,
      sync_zoom_levels: false,
    })
    expect(seeded).toEqual({
      zoom_level: 90,
      mobile_zoom_level: 110,
      sync_zoom_levels: false,
    })

    // Later server preference broadcasts must not overwrite client zoom.
    const again = resolveClientZoom({
      zoom_level: 200,
      mobile_zoom_level: 200,
      sync_zoom_levels: true,
    })
    expect(again).toEqual(seeded)
  })

  it('falls back to defaults when no seed is available', () => {
    expect(resolveClientZoom(null)).toEqual(defaultClientZoomSettings())
  })

  it('partial updates merge with existing client settings', () => {
    writeClientZoom({
      zoom_level: 100,
      mobile_zoom_level: 150,
      sync_zoom_levels: false,
    })
    expect(writeClientZoom({ zoom_level: 125 })).toEqual({
      zoom_level: 125,
      mobile_zoom_level: 150,
      sync_zoom_levels: false,
    })
  })
})
