import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import {
  TOASTER_EXPAND_BY_DEFAULT,
  shouldEnableToastActionHotkey,
  triggerLatestToastAction,
} from '@/components/ui/sonner'

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal()),
  isNativeApp: () =>
    (globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean })
      .__JEAN_TEST_IS_NATIVE__ ?? true,
}))

describe('toast stack', () => {
  it('overlaps notifications until the user interacts with the stack', () => {
    expect(TOASTER_EXPAND_BY_DEFAULT).toBe(false)
  })
})

describe('triggerLatestToastAction', () => {
  it('runs the newest toast action', () => {
    const olderAction = vi.fn()
    const newestAction = vi.fn()

    const handled = triggerLatestToastAction([
      {
        id: 'older',
        action: { label: 'Open', onClick: olderAction },
      },
      {
        id: 'newest',
        action: { label: 'Resolve Conflicts', onClick: newestAction },
      },
    ])

    expect(handled).toBe(true)
    expect(olderAction).not.toHaveBeenCalled()
    expect(newestAction).toHaveBeenCalledTimes(1)
  })

  it('dismisses the toast after running its action', () => {
    const dismissSpy = vi.spyOn(toast, 'dismiss').mockImplementation(() => '')
    const action = vi.fn()

    const handled = triggerLatestToastAction([
      {
        id: 'action-toast',
        action: { label: 'Resolve Conflicts', onClick: action },
      },
    ])

    expect(handled).toBe(true)
    expect(action).toHaveBeenCalledTimes(1)
    expect(dismissSpy).toHaveBeenCalledWith('action-toast')
  })

  it('ignores toasts without object actions', () => {
    const handled = triggerLatestToastAction([
      { id: 'plain' },
      { id: 'custom', action: <button type="button">Custom</button> },
    ])

    expect(handled).toBe(false)
  })
})

describe('shouldEnableToastActionHotkey', () => {
  it('enables the notification default action hotkey on native desktop', () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = true
    expect(shouldEnableToastActionHotkey(1024)).toBe(true)
  })

  it('disables the notification default action hotkey in web access', () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = false
    expect(shouldEnableToastActionHotkey(1024)).toBe(false)
  })

  it('disables the notification default action hotkey on mobile width', () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = true
    expect(shouldEnableToastActionHotkey(390)).toBe(false)
  })
})
