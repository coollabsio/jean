import { describe, expect, it } from 'vitest'
import {
  isLowDensityDisplay,
  shouldShowExternalDisplayZoomTip,
} from './use-external-display-zoom-tip'

describe('isLowDensityDisplay', () => {
  it('treats 1× and near-1× as low density', () => {
    expect(isLowDensityDisplay(1)).toBe(true)
    expect(isLowDensityDisplay(1.0)).toBe(true)
    expect(isLowDensityDisplay(0.999)).toBe(true)
  })

  it('treats Retina / HiDPI as high density', () => {
    expect(isLowDensityDisplay(2)).toBe(false)
    expect(isLowDensityDisplay(1.25)).toBe(false)
    expect(isLowDensityDisplay(1.5)).toBe(false)
  })
})

describe('shouldShowExternalDisplayZoomTip', () => {
  it('shows on native 1× displays when zoom is not 100% and tip is unseen', () => {
    expect(
      shouldShowExternalDisplayZoomTip({
        isNative: true,
        zoomLevel: 90,
        hasSeenTip: false,
        devicePixelRatio: 1,
      })
    ).toBe(true)
  })

  it('hides when zoom is already 100%', () => {
    expect(
      shouldShowExternalDisplayZoomTip({
        isNative: true,
        zoomLevel: 100,
        hasSeenTip: false,
        devicePixelRatio: 1,
      })
    ).toBe(false)
  })

  it('hides after the tip was dismissed', () => {
    expect(
      shouldShowExternalDisplayZoomTip({
        isNative: true,
        zoomLevel: 90,
        hasSeenTip: true,
        devicePixelRatio: 1,
      })
    ).toBe(false)
  })

  it('hides in web clients and on HiDPI displays', () => {
    expect(
      shouldShowExternalDisplayZoomTip({
        isNative: false,
        zoomLevel: 90,
        hasSeenTip: false,
        devicePixelRatio: 1,
      })
    ).toBe(false)
    expect(
      shouldShowExternalDisplayZoomTip({
        isNative: true,
        zoomLevel: 90,
        hasSeenTip: false,
        devicePixelRatio: 2,
      })
    ).toBe(false)
  })
})
