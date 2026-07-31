import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureBodyCanReceiveFocus,
  hasFocusOwningOverlay,
  installWindowKeyboardFocusRestore,
  isMeaningfulFocusTarget,
  restoreKeyboardFocusAfterWindowActivation,
} from './restore-keyboard-focus'

describe('restore-keyboard-focus', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.body.removeAttribute('tabindex')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    document.body.removeAttribute('tabindex')
  })

  describe('isMeaningfulFocusTarget', () => {
    it('rejects body and documentElement', () => {
      expect(isMeaningfulFocusTarget(document.body)).toBe(false)
      expect(isMeaningfulFocusTarget(document.documentElement)).toBe(false)
      expect(isMeaningfulFocusTarget(null)).toBe(false)
    })

    it('accepts input elements', () => {
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      expect(isMeaningfulFocusTarget(input)).toBe(true)
    })
  })

  describe('hasFocusOwningOverlay', () => {
    it('detects open dialogs', () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('data-state', 'open')
      document.body.appendChild(dialog)
      expect(hasFocusOwningOverlay()).toBe(true)
    })

    it('is false when no overlay is open', () => {
      expect(hasFocusOwningOverlay()).toBe(false)
    })
  })

  describe('ensureBodyCanReceiveFocus', () => {
    it('sets tabindex=-1 when missing', () => {
      ensureBodyCanReceiveFocus()
      expect(document.body.getAttribute('tabindex')).toBe('-1')
    })

    it('does not overwrite an existing tabindex', () => {
      document.body.tabIndex = 0
      ensureBodyCanReceiveFocus()
      expect(document.body.tabIndex).toBe(0)
    })
  })

  describe('restoreKeyboardFocusAfterWindowActivation', () => {
    it('re-asserts focus on the current active element', () => {
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      input.focus()
      const focusSpy = vi.spyOn(input, 'focus')

      expect(restoreKeyboardFocusAfterWindowActivation(null)).toBe('active')
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
      expect(document.activeElement).toBe(input)
    })

    it('restores last focused element when activeElement is body', () => {
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      document.body.tabIndex = -1
      document.body.focus()
      expect(document.activeElement).toBe(document.body)

      expect(restoreKeyboardFocusAfterWindowActivation(input)).toBe('last')
      expect(document.activeElement).toBe(input)
    })

    it('dispatches focus-chat-input when nothing else can be restored', () => {
      const handler = vi.fn()
      window.addEventListener('focus-chat-input', handler)

      // Simulate ChatWindow listener focusing a textarea
      const input = document.createElement('textarea')
      document.body.appendChild(input)
      const chatListener = () => input.focus()
      window.addEventListener('focus-chat-input', chatListener)

      document.body.tabIndex = -1
      document.body.focus()

      expect(restoreKeyboardFocusAfterWindowActivation(null)).toBe('chat')
      expect(handler).toHaveBeenCalled()
      expect(document.activeElement).toBe(input)

      window.removeEventListener('focus-chat-input', handler)
      window.removeEventListener('focus-chat-input', chatListener)
    })

    it('falls back to body when chat is not mounted', () => {
      document.body.tabIndex = -1
      // Ensure no meaningful focus
      document.body.focus()

      expect(restoreKeyboardFocusAfterWindowActivation(null)).toBe('body')
      expect(document.activeElement).toBe(document.body)
      expect(document.body.getAttribute('tabindex')).toBe('-1')
    })

    it('does not steal focus when a dialog is open', () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('data-state', 'open')
      const dialogInput = document.createElement('input')
      dialog.appendChild(dialogInput)
      document.body.appendChild(dialog)
      dialogInput.focus()
      const focusSpy = vi.spyOn(dialogInput, 'focus')

      const outside = document.createElement('textarea')
      document.body.appendChild(outside)

      expect(restoreKeyboardFocusAfterWindowActivation(outside)).toBe('overlay')
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
      expect(document.activeElement).toBe(dialogInput)
    })

    it('re-asserts meaningful active focus when an overlay is open', () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('data-state', 'open')
      document.body.appendChild(dialog)

      const activeInput = document.createElement('input')
      document.body.appendChild(activeInput)
      activeInput.focus()
      const focusSpy = vi.spyOn(activeInput, 'focus')
      const chatFocusHandler = vi.fn()
      window.addEventListener('focus-chat-input', chatFocusHandler)

      expect(restoreKeyboardFocusAfterWindowActivation(null)).toBe('overlay')
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
      expect(chatFocusHandler).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(activeInput)

      window.removeEventListener('focus-chat-input', chatFocusHandler)
    })

    it('focuses an overlay control when activeElement is body', () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('data-state', 'open')
      const dialogInput = document.createElement('input')
      dialog.appendChild(dialogInput)
      document.body.appendChild(dialog)
      document.body.tabIndex = -1
      document.body.focus()

      expect(restoreKeyboardFocusAfterWindowActivation(null)).toBe('overlay')
      expect(document.activeElement).toBe(dialogInput)
    })

    it('ignores lastFocused when it was removed from the document', () => {
      const detached = document.createElement('textarea')
      // never appended
      const handler = vi.fn(() => {
        /* no chat listener */
      })
      window.addEventListener('focus-chat-input', handler)

      document.body.tabIndex = -1
      document.body.focus()

      expect(restoreKeyboardFocusAfterWindowActivation(detached)).toBe('body')
      expect(handler).toHaveBeenCalled()

      window.removeEventListener('focus-chat-input', handler)
    })
  })

  describe('installWindowKeyboardFocusRestore', () => {
    it('restores last focused element on window focus', () => {
      vi.useFakeTimers()

      const input = document.createElement('textarea')
      document.body.appendChild(input)

      const cleanup = installWindowKeyboardFocusRestore()
      input.focus()

      // Simulate alt-tab away: focus moves to body
      document.body.tabIndex = -1
      document.body.focus()
      expect(document.activeElement).toBe(document.body)

      // Simulate alt-tab back
      window.dispatchEvent(new Event('focus'))
      vi.runAllTimers()

      expect(document.activeElement).toBe(input)

      cleanup()
      vi.useRealTimers()
    })

    it('cleans up listeners', () => {
      const cleanup = installWindowKeyboardFocusRestore()
      cleanup()

      const input = document.createElement('textarea')
      document.body.appendChild(input)
      input.focus()

      document.body.tabIndex = -1
      document.body.focus()
      window.dispatchEvent(new Event('focus'))

      // Without the listener, focus stays on body
      expect(document.activeElement).toBe(document.body)
    })
  })
})
