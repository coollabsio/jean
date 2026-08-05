import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPreferences:
  | {
      ui_font_size?: number
      chat_font_size?: number
      ui_font?: string
      chat_font?: string
      font_weight?: string
    }
  | undefined

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mockPreferences }),
}))

import { useFontSettings } from './use-font-settings'

function clearFontCssVars() {
  const root = document.documentElement
  for (const prop of [
    '--ui-font-size',
    '--chat-font-size',
    '--ui-font-weight',
    '--chat-font-weight',
    '--font-weight-normal',
    '--font-weight-medium',
    '--font-weight-semibold',
    '--font-weight-bold',
  ]) {
    root.style.removeProperty(prop)
  }
  delete root.dataset.fontWeight
}

describe('useFontSettings', () => {
  beforeEach(() => {
    mockPreferences = {
      ui_font_size: 14,
      chat_font_size: 18,
      ui_font: 'geist',
      chat_font: 'inter',
      font_weight: 'normal',
    }
    clearFontCssVars()
  })

  afterEach(() => {
    clearFontCssVars()
  })

  it('stores app font sizes in rem so web zoom can reflow layout', async () => {
    renderHook(() => useFontSettings())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--ui-font-size')
      ).toBe('0.875rem')
    })
    expect(
      document.documentElement.style.getPropertyValue('--chat-font-size')
    ).toBe('1.125rem')
  })

  it('applies the light weight ladder for softer dark-mode reading', async () => {
    mockPreferences = {
      ...(mockPreferences ?? {}),
      font_weight: 'light',
    }
    renderHook(() => useFontSettings())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--ui-font-weight')
      ).toBe('400')
    })
    expect(
      document.documentElement.style.getPropertyValue('--font-weight-medium')
    ).toBe('400')
    expect(
      document.documentElement.style.getPropertyValue('--font-weight-semibold')
    ).toBe('500')
    expect(
      document.documentElement.style.getPropertyValue('--font-weight-bold')
    ).toBe('600')
    expect(document.documentElement.dataset.fontWeight).toBe('light')
  })

  it('applies the medium weight ladder when requested', async () => {
    mockPreferences = {
      ...(mockPreferences ?? {}),
      font_weight: 'medium',
    }
    renderHook(() => useFontSettings())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--ui-font-weight')
      ).toBe('500')
    })
    expect(
      document.documentElement.style.getPropertyValue('--font-weight-medium')
    ).toBe('600')
    expect(
      document.documentElement.style.getPropertyValue('--font-weight-semibold')
    ).toBe('700')
  })

  it('falls back to normal weights for unknown values', async () => {
    mockPreferences = {
      ...(mockPreferences ?? {}),
      font_weight: 'extra-bold',
    }
    renderHook(() => useFontSettings())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--ui-font-weight')
      ).toBe('400')
    })
    expect(
      document.documentElement.style.getPropertyValue('--font-weight-medium')
    ).toBe('500')
    expect(document.documentElement.dataset.fontWeight).toBe('normal')
  })
})
