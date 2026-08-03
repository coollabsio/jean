import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  copyToClipboard,
  normalizeClipboardForTerminal,
  readFromClipboard,
} from '@/lib/clipboard'
import {
  focusTerminal,
  getTerminalSelection,
  writeTerminalInput,
} from '@/lib/terminal-instances'
import {
  applyCtrlModifier,
  resolveStickyKeyData,
  TERMINAL_EXTRA_KEYS,
  type TerminalExtraKeyAction,
} from '@/lib/terminal-extra-keys'

interface TerminalExtraKeysBarProps {
  terminalId: string
  className?: string
  /** When true, omit home-indicator safe-area padding (keyboard already lifts us). */
  keyboardOpen?: boolean
}

function actionAriaLabel(action: TerminalExtraKeyAction): string {
  if (action.type === 'toggle') return `Toggle ${action.label}`
  if (action.type === 'clipboard') {
    return action.action === 'copy'
      ? 'Copy selected terminal text'
      : 'Paste from clipboard'
  }
  return `Send ${action.label}`
}

/**
 * Termius-style special-keys strip for web access and mobile soft keyboards.
 * One-shot keys inject control sequences; Ctrl/Alt are sticky for the next char.
 * Copy/paste use the system clipboard (mobile native paste often fails on xterm).
 */
export function TerminalExtraKeysBar({
  terminalId,
  className,
  keyboardOpen = false,
}: TerminalExtraKeysBarProps) {
  const [stickyCtrl, setStickyCtrl] = useState(false)
  const [stickyAlt, setStickyAlt] = useState(false)

  const sendData = useCallback(
    (data: string) => {
      writeTerminalInput(terminalId, data)
      focusTerminal(terminalId)
    },
    [terminalId]
  )

  const clearSticky = useCallback(() => {
    setStickyCtrl(false)
    setStickyAlt(false)
  }, [])

  // When sticky Ctrl/Alt is active, capture the next keystroke and transform it.
  // useEffectEvent keeps latest sendData/sticky state without re-binding.
  const onStickyKeyDown = useEffectEvent((event: KeyboardEvent) => {
    // Only intercept when focus is still in this terminal (or nothing stole it).
    const terminalRoot = document.querySelector(
      `[data-terminal-id="${terminalId}"]`
    )
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      terminalRoot &&
      !terminalRoot.contains(active) &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable)
    ) {
      return
    }

    const data = resolveStickyKeyData(event, stickyCtrl, stickyAlt)
    if (data === null) return

    event.preventDefault()
    event.stopPropagation()
    sendData(data)
    clearSticky()
  })

  useEffect(() => {
    if (!stickyCtrl && !stickyAlt) return

    const onKeyDown = (event: KeyboardEvent) => onStickyKeyDown(event)
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [stickyCtrl, stickyAlt])

  // Reset sticky modifiers when switching terminals.
  useEffect(() => {
    setStickyCtrl(false)
    setStickyAlt(false)
  }, [terminalId])

  const handleCopy = useCallback(async () => {
    const selection = getTerminalSelection(terminalId).trimEnd()
    if (!selection) {
      toast.error('No text selected')
      focusTerminal(terminalId)
      return
    }

    try {
      await copyToClipboard(selection)
      toast.success('Copied')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to copy selection'
      )
    } finally {
      focusTerminal(terminalId)
    }
  }, [terminalId])

  const handlePaste = useCallback(async () => {
    try {
      const raw = await readFromClipboard()
      const text = normalizeClipboardForTerminal(raw)
      if (!text) {
        toast.error('Clipboard is empty')
        return
      }
      writeTerminalInput(terminalId, text)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to paste from clipboard'
      )
    } finally {
      focusTerminal(terminalId)
      clearSticky()
    }
  }, [terminalId, clearSticky])

  const handleKey = useCallback(
    (action: TerminalExtraKeyAction) => {
      if (action.type === 'clipboard') {
        if (action.action === 'copy') {
          void handleCopy()
        } else {
          void handlePaste()
        }
        return
      }

      if (action.type === 'toggle') {
        if (action.modifier === 'ctrl') {
          setStickyCtrl(prev => !prev)
          setStickyAlt(false)
        } else {
          setStickyAlt(prev => !prev)
          setStickyCtrl(false)
        }
        focusTerminal(terminalId)
        return
      }

      // One-shot data key. If sticky Ctrl/Alt is on and this is a single
      // printable char, apply the modifier; control chords (^C etc.) send as-is.
      let data = action.data
      if (stickyCtrl && data.length === 1) {
        const ctrlData = applyCtrlModifier(data)
        if (ctrlData !== null) data = ctrlData
      } else if (stickyAlt && data.length === 1) {
        data = `\x1b${data}`
      }

      sendData(data)
      clearSticky()
    },
    [
      terminalId,
      stickyCtrl,
      stickyAlt,
      sendData,
      clearSticky,
      handleCopy,
      handlePaste,
    ]
  )

  return (
    <div
      data-testid="terminal-extra-keys-bar"
      className={cn(
        'shrink-0 border-t border-border/60 bg-background/95 backdrop-blur-sm',
        // Home-indicator inset only when the soft keyboard is closed; when open
        // the parent applies visual-viewport padding so we already sit above it.
        !keyboardOpen && 'pb-[env(safe-area-inset-bottom,0px)]',
        className
      )}
      // Keep terminal focused: prevent bar buttons from taking keyboard focus.
      // Use pointerdown so touch + mouse both avoid focus steal.
      onPointerDown={e => e.preventDefault()}
    >
      <div
        role="toolbar"
        aria-label="Terminal special keys"
        className="flex gap-1.5 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TERMINAL_EXTRA_KEYS.map(action => {
          const isActive =
            action.type === 'toggle' &&
            ((action.modifier === 'ctrl' && stickyCtrl) ||
              (action.modifier === 'alt' && stickyAlt))

          return (
            <button
              key={action.label}
              type="button"
              aria-label={actionAriaLabel(action)}
              aria-pressed={action.type === 'toggle' ? isActive : undefined}
              className={cn(
                'inline-flex h-8 min-w-[2.25rem] shrink-0 items-center justify-center rounded-full px-2.5',
                'text-xs font-medium tabular-nums tracking-wide',
                'border border-border/70 bg-muted/40 text-muted-foreground',
                'active:scale-95 transition-colors touch-manipulation select-none',
                'hover:bg-muted hover:text-foreground',
                isActive &&
                  'border-primary/60 bg-primary/20 text-primary hover:bg-primary/25'
              )}
              onClick={() => handleKey(action)}
            >
              {action.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
