/**
 * Standalone terminal surface for login/install flows and other one-off PTYs.
 *
 * Same mobile/web chrome as TerminalView: arrow gesture pad above the
 * emulator and Termius-style extra-keys bar below, with soft-keyboard inset.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useTerminalBackgroundColor } from '@/hooks/useTerminalThemeSync'
import { useIsMobile } from '@/hooks/use-mobile'
import { useVisualViewportBottomInset } from '@/hooks/useVisualViewportBottomInset'
import { isNativeApp } from '@/lib/environment'
import { isLoginTerminalContainerReady } from '@/lib/terminal-dimensions'
import { focusTerminal, writeTerminalInput } from '@/lib/terminal-instances'
import {
  normalizeClipboardForTerminal,
  readFromClipboard,
} from '@/lib/clipboard'
import { isModKeyEvent } from '@/types/keybindings'
import { cn } from '@/lib/utils'
import { TerminalArrowGesture } from './TerminalArrowGesture'
import { TerminalExtraKeysBar } from './TerminalExtraKeysBar'
import '@xterm/xterm/css/xterm.css'

export interface StandaloneTerminalSurfaceProps {
  terminalId: string
  command: string
  commandArgs?: string[] | null
  /** Synthetic worktree id for PTY bookkeeping (default: cli-login). */
  worktreeId?: string
  worktreePath?: string
  className?: string
  /** When false, skip arrow pad + extra keys (native desktop default still applies). */
  forceExtraKeys?: boolean
}

/**
 * Full terminal body: resize-aware xterm attach + optional mobile/web chrome.
 * Parents own stop/dispose and exit handlers; this only attaches UI.
 */
export function StandaloneTerminalSurface({
  terminalId,
  command,
  commandArgs,
  worktreeId = 'cli-login',
  worktreePath = '/tmp',
  className,
  forceExtraKeys,
}: StandaloneTerminalSurfaceProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  // Callback-as-state: dialogs/portals often mount at 0×0; observer waits for a real size.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const isMobile = useIsMobile()
  // Soft-keyboard special keys + arrow gesture: web access always, plus narrow viewports.
  const showExtraKeys =
    forceExtraKeys === true ||
    (forceExtraKeys !== false && (!isNativeApp() || isMobile))
  const keyboardInset = useVisualViewportBottomInset(rootRef, showExtraKeys)
  const terminalBg = useTerminalBackgroundColor()

  const handleNativePaste = async (event: KeyboardEvent) => {
    if (
      !isNativeApp() ||
      event.code !== 'KeyV' ||
      event.shiftKey ||
      event.altKey ||
      !isModKeyEvent(event.nativeEvent)
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const text = normalizeClipboardForTerminal(await readFromClipboard())
    writeTerminalInput(terminalId, text)
  }

  const { initTerminal, fit, focus } = useTerminal({
    terminalId,
    worktreeId,
    worktreePath,
    command,
    commandArgs,
  })

  // ResizeObserver owns init + fit; disconnect on container change / unmount.
  // Wait for a minimum size so login TUI CLIs (OpenCode auth, etc.) are not
  // spawned during dialog zoom with a tiny PTY (issue #624).
  useEffect(() => {
    if (!container) return

    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      const { width, height } = entry?.contentRect ?? { width: 0, height: 0 }

      if (!entry || width === 0 || height === 0) {
        return
      }

      if (!initialized.current) {
        if (!isLoginTerminalContainerReady(width, height)) {
          return
        }
        initialized.current = true
        void initTerminal(container)
        return
      }

      fit()
    })

    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [container, initTerminal, fit])

  // Soft keyboard open/close changes padding → re-fit the emulator.
  useEffect(() => {
    if (!initialized.current) return
    const timeoutId = setTimeout(() => fit(), 50)
    return () => clearTimeout(timeoutId)
  }, [keyboardInset, fit])

  // Reset init guard when terminal identity changes (retry remounts).
  useEffect(() => {
    initialized.current = false
  }, [terminalId])

  return (
    <div
      ref={rootRef}
      data-terminal-id={terminalId}
      data-testid="standalone-terminal-surface"
      data-keyboard-inset={keyboardInset > 0 ? keyboardInset : undefined}
      className={cn(
        'relative flex min-h-0 w-full flex-col overflow-hidden rounded-md border border-border',
        className
      )}
      style={{
        backgroundColor: terminalBg,
        // Lift the extra-keys bar (and shrink the emulator) above the soft keyboard.
        paddingBottom: keyboardInset > 0 ? keyboardInset : undefined,
      }}
      onMouseDown={() => {
        focus()
        focusTerminal(terminalId)
      }}
      onKeyDownCapture={event => void handleNativePaste(event)}
    >
      {/* Pad chrome sits above the emulator so long-press arrows never cover text. */}
      {showExtraKeys && (
        <TerminalArrowGesture
          terminalId={terminalId}
          surfaceRef={surfaceRef}
          enabled
        />
      )}
      <div
        ref={surfaceRef}
        className={cn(
          'relative min-h-0 flex-1 touch-manipulation p-2 sm:p-3',
          // Avoid iOS callout / accidental selection while using the long-press pad.
          isMobile && 'select-none [-webkit-touch-callout:none]'
        )}
      >
        <div ref={setContainer} className="h-full w-full overflow-hidden" />
      </div>
      {showExtraKeys && (
        <TerminalExtraKeysBar
          terminalId={terminalId}
          keyboardOpen={keyboardInset > 0}
        />
      )}
    </div>
  )
}
