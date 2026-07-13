/**
 * Module-level storage for embedded terminal instances.
 *
 * This decouples terminal lifecycle from React component lifecycle.
 * Terminals persist across component mount/unmount cycles, preserving
 * buffer content, cursor position, and running processes.
 *
 * Only disposed when user explicitly closes the terminal.
 */

import { Terminal as XtermTerminal } from '@xterm/xterm'
import { FitAddon as XtermFitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import {
  init as initGhosttyWeb,
  Terminal as GhosttyWebTerminal,
  FitAddon as GhosttyWebFitAddon,
} from 'ghostty-web'
import { openExternal } from '@/lib/platform'
import { attachOrphanCompositionEndGuard } from '@/lib/terminal-composition-guard'
import { LocalTerminalLinkProvider } from '@/lib/terminal-local-links'
import { ensureTerminalFontLoaded } from '@/lib/terminal-font-loading'
import {
  invoke,
  isTransportConnected,
  requestTerminalReplay,
} from '@/lib/transport'
import { listen } from '@/lib/transport'
import { queryClient } from '@/lib/query-client'
import { preferencesQueryKeys } from '@/services/preferences'
import { isPanelTerminal, useTerminalStore } from '@/store/terminal-store'
import {
  defaultPreferences,
  type AppPreferences,
  type TerminalFont,
} from '@/types/preferences'
import type {
  TerminalOutputEvent,
  TerminalStartedEvent,
  TerminalStoppedEvent,
} from '@/types/terminal'
import {
  resolveTerminalTheme,
  type ResolvedTerminalTheme,
} from '@/lib/terminal-theme'

type TerminalRenderer = 'xterm' | 'ghostty-web'
type EmbeddedTerminal = XtermTerminal | GhosttyWebTerminal
type EmbeddedFitAddon = XtermFitAddon | GhosttyWebFitAddon

interface TerminalAppearance {
  fontFamily: string
  fontSize: number
  theme: ReturnType<typeof getTerminalTheme>
}

interface PersistentTerminal {
  terminalId: string
  terminal: EmbeddedTerminal | null
  fitAddon: EmbeddedFitAddon | null
  renderer: TerminalRenderer
  hostElement: HTMLDivElement | null
  worktreeId: string
  worktreePath: string
  command: string | null
  commandArgs: string[] | null
  initialized: boolean // PTY has been started
  replayRequested: boolean // Buffered web replay has been requested for an existing PTY
  opened: boolean // Terminal UI has been opened into hostElement
  readyForOutput: boolean // Ghostty Web needs one settled paint before writes
  outputReadyPromise: Promise<void> | null
  pendingOutput: string[]
  lastAppearance: TerminalAppearance | null
  appearanceLoadVersion: number
  appearanceResizeTimer: ReturnType<typeof setTimeout> | null
  touchScrollCleanup: (() => void) | null
  compositionGuardCleanup: (() => void) | null
  onStopped?: (exitCode: number | null, signal: string | null) => void
}

// Module-level Map - persists across React mount/unmount cycles
const instances = new Map<string, PersistentTerminal>()
const inputBuffers = new Map<
  string,
  { data: string; timer: ReturnType<typeof setTimeout> | null }
>()
const outputBuffers = new Map<string, { data: string; scheduled: boolean }>()
// Pending onStopped callbacks for terminals not yet created
const pendingOnStopped = new Map<
  string,
  (exitCode: number | null, signal: string | null) => void
>()

let ghosttyWebReady: Promise<void> | null = null
let preferencesSubscriptionRegistered = false

const terminalFontFamilyMap: Record<TerminalFont, string> = {
  'jetbrains-mono':
    '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
  'fira-code':
    '"Fira Code", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
  'source-code-pro':
    '"Source Code Pro", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
  'sf-mono': '"SF Mono", Menlo, Monaco, Consolas, monospace',
  system: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
}

function getConfiguredRenderer(): TerminalRenderer {
  const preferences = queryClient.getQueryData<AppPreferences>(
    preferencesQueryKeys.preferences()
  )
  const renderer =
    preferences?.terminal_renderer ?? defaultPreferences.terminal_renderer
  return renderer === 'ghostty-web' ? 'ghostty-web' : 'xterm'
}

function ensureGhosttyWebReady(): Promise<void> {
  if (!ghosttyWebReady) {
    ghosttyWebReady = initGhosttyWeb()
  }
  return ghosttyWebReady
}

function getTerminalFontFamily(): string {
  const preferences = queryClient.getQueryData<AppPreferences>(
    preferencesQueryKeys.preferences()
  )
  const font = preferences?.terminal_font ?? defaultPreferences.terminal_font
  return (
    terminalFontFamilyMap[
      font ?? defaultPreferences.terminal_font ?? 'system'
    ] ?? terminalFontFamilyMap.system
  )
}

function getTerminalFontSize(): number {
  const preferences = queryClient.getQueryData<AppPreferences>(
    preferencesQueryKeys.preferences()
  )
  const size =
    preferences?.terminal_font_size ?? defaultPreferences.terminal_font_size
  return typeof size === 'number' && Number.isFinite(size)
    ? Math.min(24, Math.max(10, size))
    : 13
}

function getTerminalAppearance(): TerminalAppearance {
  return {
    fontFamily: getTerminalFontFamily(),
    fontSize: getTerminalFontSize(),
    theme: getTerminalTheme(),
  }
}

function hasSameFont(
  first: TerminalAppearance,
  second: TerminalAppearance
): boolean {
  return (
    first.fontFamily === second.fontFamily && first.fontSize === second.fontSize
  )
}

async function getLoadedTerminalAppearance(): Promise<TerminalAppearance> {
  let appearance = getTerminalAppearance()

  while (true) {
    await ensureTerminalFontLoaded(appearance.fontFamily, appearance.fontSize)
    const current = getTerminalAppearance()
    if (hasSameFont(appearance, current)) return current
    appearance = current
  }
}

function hasThemeChanged(
  previous: TerminalAppearance | null,
  next: TerminalAppearance
): boolean {
  if (!previous) return true
  return (
    previous.theme.background !== next.theme.background ||
    previous.theme.foreground !== next.theme.foreground ||
    previous.theme.cursor !== next.theme.cursor ||
    previous.theme.selectionBackground !== next.theme.selectionBackground ||
    previous.theme.selectionForeground !== next.theme.selectionForeground
  )
}

function scheduleAppearanceResize(instance: PersistentTerminal): void {
  if (!instance.terminal || !instance.fitAddon) return
  if (instance.appearanceResizeTimer) {
    clearTimeout(instance.appearanceResizeTimer)
  }

  instance.appearanceResizeTimer = setTimeout(() => {
    instance.appearanceResizeTimer = null
    if (!instance.terminal || !instance.fitAddon) return
    instance.fitAddon.fit()
    const { cols, rows } = getSafeTerminalDimensions(instance.terminal)
    if (!instance.initialized) return
    invoke('terminal_resize', {
      terminalId: instance.terminalId,
      cols,
      rows,
    }).catch(console.error)
  }, 120)
}

function getSafeTerminalDimensions(terminal: EmbeddedTerminal): {
  cols: number
  rows: number
} {
  const rawCols = terminal.cols
  const rawRows = terminal.rows
  const rows = rawRows < 2 ? 24 : rawRows
  const cols = rawCols < 2 ? 80 : rawCols
  return { cols, rows }
}

function disableGhosttyScrollbar(instance: PersistentTerminal): void {
  if (instance.renderer !== 'ghostty-web' || !instance.terminal) return

  const renderer = (instance.terminal as GhosttyWebTerminal).renderer as
    | { renderScrollbar?: (...args: unknown[]) => void }
    | undefined

  if (renderer?.renderScrollbar) {
    renderer.renderScrollbar = () => undefined
  }
}

/** Translate vertical touch drags into terminal scrollback movement.
 *  xterm.js v6 has no touch handling — the `.xterm-screen` layer paints over
 *  the scrollable `.xterm-viewport`, so native touch-drag never scrolls it.
 *  Returns a cleanup fn that removes the listeners (null if unsupported). */
function attachTouchScroll(instance: PersistentTerminal): (() => void) | null {
  const terminal = instance.terminal
  const host = instance.hostElement
  if (!terminal || !host) return null

  const scrollLines = (terminal as { scrollLines?: (amount: number) => void })
    .scrollLines
  if (typeof scrollLines !== 'function') return null

  let lastY: number | null = null
  let remainder = 0

  const cellHeight = (): number => {
    const rows = terminal.rows
    const height = host.clientHeight
    if (rows >= 1 && Number.isFinite(height) && height > 0) {
      return height / rows
    }
    // Fallback: font size with typical line-height when dimensions are absent.
    return Math.max(8, getTerminalFontSize() * 1.2)
  }

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      lastY = null
      return
    }
    lastY = event.touches[0]?.clientY ?? null
    remainder = 0
  }

  const onTouchMove = (event: TouchEvent): void => {
    if (lastY === null || event.touches.length !== 1) return
    const y = event.touches[0]?.clientY
    if (y === undefined) return

    // Finger moving down (y increases) reveals older scrollback → scroll up.
    remainder += lastY - y
    lastY = y

    const unit = cellHeight()
    const lines = Math.trunc(remainder / unit)
    if (lines !== 0) {
      remainder -= lines * unit
      scrollLines.call(terminal, lines)
    }
    // Suppress page scroll / pull-to-refresh while dragging in the terminal.
    event.preventDefault()
  }

  const onTouchEnd = (): void => {
    lastY = null
    remainder = 0
  }

  host.addEventListener('touchstart', onTouchStart, { passive: true })
  host.addEventListener('touchmove', onTouchMove, { passive: false })
  host.addEventListener('touchend', onTouchEnd, { passive: true })
  host.addEventListener('touchcancel', onTouchEnd, { passive: true })

  return () => {
    host.removeEventListener('touchstart', onTouchStart)
    host.removeEventListener('touchmove', onTouchMove)
    host.removeEventListener('touchend', onTouchEnd)
    host.removeEventListener('touchcancel', onTouchEnd)
  }
}

function clearFreshTerminalDisplay(instance: PersistentTerminal): void {
  if (!instance.terminal) return

  try {
    instance.terminal.clear()
  } catch {
    // ignore — some renderers may not be fully drawable until the next frame
  }
}

function scheduleAnimationFrame(callback: () => void): void {
  // requestAnimationFrame is paused when the document is hidden, and macOS
  // App Nap / window minimization can suspend the webview for minutes at a
  // time. Fall back to setTimeout while hidden so PTY output and echo keep
  // flowing — otherwise terminals appear frozen after a few minutes idle.
  const hidden =
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (!hidden && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback)
    return
  }
  setTimeout(callback, 16)
}

function scheduleGhosttyOutputReady(
  instance: PersistentTerminal
): Promise<void> {
  if (instance.renderer !== 'ghostty-web') {
    instance.readyForOutput = true
    instance.outputReadyPromise = Promise.resolve()
    return instance.outputReadyPromise
  }

  instance.readyForOutput = false
  instance.outputReadyPromise = new Promise(resolve => {
    scheduleAnimationFrame(() => {
      scheduleAnimationFrame(() => {
        window.setTimeout(() => {
          if (!instances.has(instance.terminalId) || !instance.terminal) {
            resolve()
            return
          }

          instance.readyForOutput = true
          if (instance.pendingOutput.length > 0) {
            const bufferedOutput = instance.pendingOutput.join('')
            instance.pendingOutput = []
            queueTerminalOutput(instance, bufferedOutput)
          }
          resolve()
        }, 50)
      })
    })
  })
  return instance.outputReadyPromise
}

async function applyTerminalAppearance(
  instance: PersistentTerminal
): Promise<void> {
  if (!instance.terminal) return

  const loadVersion = ++instance.appearanceLoadVersion
  const next = getTerminalAppearance()
  const previous = instance.lastAppearance
  const fontChanged =
    !previous ||
    previous.fontFamily !== next.fontFamily ||
    previous.fontSize !== next.fontSize
  const themeChanged = hasThemeChanged(previous, next)

  if (!fontChanged && !themeChanged) return

  if (fontChanged) {
    await ensureTerminalFontLoaded(next.fontFamily, next.fontSize)
    if (
      loadVersion !== instance.appearanceLoadVersion ||
      !isCurrentInstance(instance.terminalId, instance) ||
      !instance.terminal ||
      !hasSameFont(next, getTerminalAppearance())
    ) {
      return
    }
  }

  const current = getTerminalAppearance()
  const currentThemeChanged = hasThemeChanged(previous, current)

  if (currentThemeChanged) {
    instance.terminal.options.theme = current.theme
  }
  if (fontChanged) {
    instance.terminal.options.fontFamily = current.fontFamily
    instance.terminal.options.fontSize = current.fontSize
    scheduleAppearanceResize(instance)
  }

  instance.lastAppearance = current
}

function ensurePreferencesSubscription(): void {
  if (preferencesSubscriptionRegistered) return
  preferencesSubscriptionRegistered = true
  queryClient.getQueryCache().subscribe(event => {
    if (event.query.queryHash !== '["preferences"]') return
    if (event.type !== 'updated') return
    for (const instance of instances.values()) {
      void applyTerminalAppearance(instance)
    }
  })
}

/** Register one document/window wake handler that forces all xterm instances
 *  to repaint when the webview resumes from idle/sleep (issue #320).
 *  RAF-based DOM renderer can stall after macOS App Nap or DPMS sleep;
 *  terminal.refresh() kicks the render queue without needing a new frame. */
let wakeHandlerRegistered = false
function ensureWakeHandler(): void {
  if (wakeHandlerRegistered) return
  wakeHandlerRegistered = true
  const wake = () => {
    if (document.visibilityState !== 'visible') return

    // Drain any output buffered while we were hidden: the scheduled flush
    // (rAF or setTimeout) may not have fired yet, and we want the user to
    // see current PTY state immediately on resume rather than after the
    // next event arrives.
    for (const [terminalId, buffer] of [...outputBuffers]) {
      if (!buffer.data) {
        outputBuffers.delete(terminalId)
        continue
      }
      const inst = instances.get(terminalId)
      if (!inst?.terminal) {
        outputBuffers.delete(terminalId)
        continue
      }
      if (inst.renderer === 'ghostty-web' && !inst.readyForOutput) {
        inst.pendingOutput.push(buffer.data)
      } else {
        try {
          inst.terminal.write(buffer.data)
        } catch {
          // ignore — terminal may be in mid-dispose
        }
      }
      outputBuffers.delete(terminalId)
    }

    // Flush any input still sitting in the debounce window — characters
    // typed (or queued) while hidden should land now so the prompt advances.
    for (const terminalId of [...inputBuffers.keys()]) {
      flushTerminalInput(terminalId)
    }

    for (const inst of instances.values()) {
      if (!inst.terminal || inst.renderer !== 'xterm') continue
      try {
        ;(inst.terminal as XtermTerminal).refresh(
          0,
          Math.max(0, inst.terminal.rows - 1)
        )
      } catch {
        // ignore — terminal may be in mid-dispose
      }
    }
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
}

const FALLBACK_TERMINAL_BACKGROUND = '#101010'
const FALLBACK_TERMINAL_FOREGROUND = '#fafafa'

let cachedPrefs: Pick<
  AppPreferences,
  'terminal_background' | 'terminal_background_custom'
> = {
  terminal_background: 'auto',
  terminal_background_custom: null,
}

export function setTerminalPreferences(
  prefs: Pick<
    AppPreferences,
    'terminal_background' | 'terminal_background_custom'
  >
): void {
  cachedPrefs = {
    terminal_background: prefs.terminal_background,
    terminal_background_custom: prefs.terminal_background_custom,
  }
}

function getRootColorVariable(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback
  }

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()

  return value || fallback
}

function getThemeFromCss(): ResolvedTerminalTheme {
  const foreground = getRootColorVariable(
    '--card-foreground',
    FALLBACK_TERMINAL_FOREGROUND
  )

  return {
    background: getRootColorVariable(
      '--background',
      FALLBACK_TERMINAL_BACKGROUND
    ),
    foreground,
    cursor: foreground,
    selectionBackground: 'rgba(96, 165, 250, 0.35)',
    selectionForeground: foreground,
  }
}

function shouldLetAppHandleShortcut(event: KeyboardEvent): boolean {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.code === 'Escape'
  ) {
    return true
  }

  const target = event.target
  if (
    target instanceof HTMLElement &&
    target.closest('[data-terminal-surface="session"]')
  ) {
    return false
  }

  if (!event.metaKey) return false
  const code = event.code
  // CMD+` → toggle terminal panel
  if (code === 'Backquote') return true
  // CMD+T → new terminal tab
  if (!event.shiftKey && !event.altKey && code === 'KeyT') return true
  // CMD+W → close terminal tab
  if (!event.shiftKey && !event.altKey && code === 'KeyW') return true
  // CMD+1..9 → switch terminal tab
  if (!event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(code)) {
    return true
  }
  // CMD+Alt+Backspace → cancel prompt
  return event.altKey && (code === 'Backspace' || code === 'Delete')
}

const INPUT_FLUSH_DELAY_MS = 5

function shouldFlushTerminalInputNow(data: string): boolean {
  return (
    data.includes('\r') ||
    data.includes('\n') ||
    data.includes('\u0003') || // Ctrl-C
    data.includes('\u0004') || // Ctrl-D
    data.includes('\u001a') // Ctrl-Z
  )
}

function flushTerminalInput(terminalId: string): void {
  const buffer = inputBuffers.get(terminalId)
  if (!buffer) return
  if (buffer.timer) clearTimeout(buffer.timer)
  inputBuffers.delete(terminalId)
  if (!buffer.data) return
  invoke('terminal_write', { terminalId, data: buffer.data }).catch(
    console.error
  )
}

function discardTerminalInput(terminalId: string): void {
  const buffer = inputBuffers.get(terminalId)
  if (buffer?.timer) clearTimeout(buffer.timer)
  inputBuffers.delete(terminalId)
}

function queueTerminalInput(terminalId: string, data: string): void {
  if (!isTransportConnected()) return

  const buffer = inputBuffers.get(terminalId) ?? {
    data: '',
    timer: null,
  }
  buffer.data += data
  if (buffer.timer) clearTimeout(buffer.timer)

  if (shouldFlushTerminalInputNow(data)) {
    inputBuffers.set(terminalId, buffer)
    flushTerminalInput(terminalId)
    return
  }

  buffer.timer = setTimeout(
    () => flushTerminalInput(terminalId),
    INPUT_FLUSH_DELAY_MS
  )
  inputBuffers.set(terminalId, buffer)
}

function queueTerminalOutput(instance: PersistentTerminal, data: string): void {
  if (!instance.terminal) return
  if (instance.renderer === 'ghostty-web' && !instance.readyForOutput) {
    instance.pendingOutput.push(data)
    return
  }

  const terminalId = instance.terminalId
  const buffer = outputBuffers.get(terminalId) ?? {
    data: '',
    scheduled: false,
  }
  buffer.data += data
  outputBuffers.set(terminalId, buffer)

  if (buffer.scheduled) return
  buffer.scheduled = true

  scheduleAnimationFrame(() => {
    const latest = outputBuffers.get(terminalId)
    if (!latest) return
    outputBuffers.delete(terminalId)

    const current = instances.get(terminalId)
    if (!current?.terminal || !latest.data) return
    if (current.renderer === 'ghostty-web' && !current.readyForOutput) {
      current.pendingOutput.push(latest.data)
      return
    }
    try {
      current.terminal.write(latest.data)
    } catch {
      // ignore — terminal may be in mid-dispose
    }
  })
}

async function createTerminalForRenderer(
  renderer: TerminalRenderer,
  worktreePath: string
): Promise<{
  terminal: EmbeddedTerminal
  fitAddon: EmbeddedFitAddon
  appearance: TerminalAppearance
}> {
  const appearance = await getLoadedTerminalAppearance()
  const terminalOptions = {
    cursorBlink: true,
    fontSize: appearance.fontSize,
    fontFamily: appearance.fontFamily,
    fontWeight: 400,
    fontWeightBold: 500,
    theme: appearance.theme,
  }

  if (renderer === 'ghostty-web') {
    await ensureGhosttyWebReady()
    const terminal = new GhosttyWebTerminal(terminalOptions)
    terminal.attachCustomKeyEventHandler(event => {
      // ghostty-web uses the inverse convention from xterm.js:
      // true means "custom handler consumed/prevented default".
      return shouldLetAppHandleShortcut(event)
    })
    const fitAddon = new GhosttyWebFitAddon()
    terminal.loadAddon(fitAddon)
    return { terminal, fitAddon, appearance }
  }

  const terminal = new XtermTerminal({
    ...terminalOptions,
    allowProposedApi: true,
  })
  terminal.attachCustomKeyEventHandler(event => {
    if (shouldLetAppHandleShortcut(event)) return false
    // All other CMD shortcuts: xterm consumes them (prevents app actions)
    return true
  })

  const fitAddon = new XtermFitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(
    new WebLinksAddon((_event, uri) => {
      openExternal(uri)
    })
  )
  terminal.registerLinkProvider(
    new LocalTerminalLinkProvider(terminal, worktreePath, () => {
      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      return preferences?.editor
    })
  )
  return { terminal, fitAddon, appearance }
}

async function ensureTerminalCreated(
  terminalId: string,
  instance: PersistentTerminal
): Promise<EmbeddedTerminal | null> {
  if (instance.terminal) {
    instance.terminal.options.theme = getTerminalTheme()
    return instance.terminal
  }

  try {
    const { terminal, fitAddon, appearance } = await createTerminalForRenderer(
      instance.renderer,
      instance.worktreePath
    )

    if (!isCurrentInstance(terminalId, instance)) {
      terminal.dispose()
      return null
    }

    instance.terminal = terminal
    instance.fitAddon = fitAddon
    instance.lastAppearance = appearance
    registerTerminalInputHandlers(terminalId, terminal)
    return terminal
  } catch (error) {
    console.error('[terminal-instances] failed to create terminal:', error)
    return null
  }
}

function registerTerminalInputHandlers(
  terminalId: string,
  terminal: EmbeddedTerminal
): void {
  // Handle user input - forward to PTY.
  // Drop input while transport is disconnected: queueing 30s+ of keystrokes
  // and dumping them into the shell on reattach = footgun (e.g. dangerous
  // partial commands executed). Banner makes the dropped state visible.
  terminal.onData(data => {
    queueTerminalInput(terminalId, data)
  })
}

let terminalBackendListenersReady: Promise<void> | null = null

function ensureTerminalBackendListeners(): Promise<void> {
  if (terminalBackendListenersReady) return terminalBackendListenersReady

  terminalBackendListenersReady = Promise.all(
    [
      listen<TerminalOutputEvent>('terminal:output', event => {
        const terminalId = event.payload.terminal_id
        const inst = instances.get(terminalId)
        if (!inst) return
        queueTerminalOutput(inst, event.payload.data)
      }),
      listen<TerminalStartedEvent>('terminal:started', event => {
        useTerminalStore
          .getState()
          .setTerminalRunning(event.payload.terminal_id, true)
      }),
      listen<TerminalStoppedEvent>('terminal:stopped', event => {
        handleTerminalStopped(event.payload)
      }),
    ].map(listener =>
      listener.catch(error => {
        console.error(
          '[terminal-instances] failed to register listener:',
          error
        )
        return () => undefined
      })
    )
  ).then(() => undefined)

  return terminalBackendListenersReady
}

function isCurrentInstance(
  terminalId: string,
  instance: PersistentTerminal
): boolean {
  return instances.get(terminalId) === instance
}

async function waitForTerminalReady(
  terminalId: string,
  instance: PersistentTerminal
): Promise<boolean> {
  await ensureTerminalBackendListeners()
  if (!isCurrentInstance(terminalId, instance)) return false

  if (instance.outputReadyPromise) {
    await instance.outputReadyPromise
  }

  return isCurrentInstance(terminalId, instance)
}

function handleTerminalStopped(event: TerminalStoppedEvent): void {
  const terminalId = event.terminal_id
  useTerminalStore.getState().setTerminalRunning(terminalId, false)

  const inst = instances.get(terminalId)
  const exitCode = event.exit_code
  const signal = event.signal
  const exitLabel =
    signal != null ? `signal ${signal}` : `code ${exitCode ?? 'unknown'}`
  if (inst) {
    queueTerminalOutput(
      inst,
      `\r\n\x1b[90m[Process exited with ${exitLabel}]\x1b[0m\r\n`
    )
    inst.onStopped?.(exitCode, signal)
  }

  // Auto-close terminal tab on clean exit:
  // - code 0 — any terminal
  // - SIGINT (Ctrl+C) or SIGTERM (graceful stop) — user or system stop
  // SIGKILL, SIGSEGV, SIGABRT, etc. are NOT clean → mark as failed.
  const storeTerminal =
    inst &&
    (useTerminalStore.getState().terminals[inst.worktreeId] ?? []).find(
      terminal => terminal.id === terminalId
    )
  const isPanel = storeTerminal ? isPanelTerminal(storeTerminal) : true
  const isRunTerminal = inst?.command != null && isPanel
  const isIntentionalSignal =
    signal != null &&
    (signal.includes('Interrupt') || signal.includes('Terminated'))
  const isCleanExit = exitCode === 0 || isIntentionalSignal

  if (isCleanExit && inst && isPanel) {
    const wId = inst.worktreeId
    setTimeout(() => {
      if (!instances.has(terminalId)) return // Already disposed
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      invoke('stop_terminal', { terminalId }).catch(() => {})
      disposeTerminal(terminalId)
      const { removeTerminal, setTerminalPanelOpen } =
        useTerminalStore.getState()
      removeTerminal(wId, terminalId)
      const remaining = (
        useTerminalStore.getState().terminals[wId] ?? []
      ).filter(isPanelTerminal)
      if (remaining.length === 0) {
        setTerminalPanelOpen(wId, false)
        useTerminalStore.getState().setTerminalVisible(false)
        useTerminalStore.getState().setModalTerminalOpen(wId, false)
      }
    }, 0)
  } else if (isRunTerminal) {
    // Non-zero exit on a run terminal → mark as failed (red indicator in sidebar)
    useTerminalStore.getState().setTerminalFailed(terminalId, true)
  }
}

function getTerminalTheme(): ResolvedTerminalTheme {
  return resolveTerminalTheme(cachedPrefs, getThemeFromCss)
}

export function applyThemeToAllTerminals(): void {
  const theme = getTerminalTheme()
  for (const inst of instances.values()) {
    if (!inst.terminal) continue
    inst.terminal.options.theme = theme
    try {
      inst.terminal.refresh(0, Math.max(0, inst.terminal.rows - 1))
    } catch {
      // ignore — terminal may be in mid-dispose
    }
  }
}

// TODO: Add memory cap for detached terminals (e.g., 20 max)
// For now, typical usage won't hit memory limits

/**
 * Get existing terminal instance or create a new one.
 * Records which renderer this tab should use. The renderer instance and event
 * listeners are created lazily because ghostty-web requires async WASM init.
 * Does NOT start PTY - that happens in attachToContainer when first attached.
 */
export function getOrCreateTerminal(
  terminalId: string,
  options: {
    worktreeId: string
    worktreePath: string
    command?: string | null
    commandArgs?: string[] | null
  }
): PersistentTerminal {
  const existing = instances.get(terminalId)
  if (existing) {
    if (existing.terminal) {
      existing.terminal.options.theme = getTerminalTheme()
    }
    return existing
  }

  const {
    worktreeId,
    worktreePath,
    command = null,
    commandArgs = null,
  } = options

  // Ensure the visibility/focus wake handler is running.
  ensureWakeHandler()
  // Keep existing terminal renderers in sync when font settings change.
  ensurePreferencesSubscription()
  // One backend listener per terminal event type, not per terminal instance.
  void ensureTerminalBackendListeners()

  const renderer = getConfiguredRenderer()
  const instance: PersistentTerminal = {
    terminalId,
    terminal: null,
    fitAddon: null,
    renderer,
    hostElement: null,
    worktreeId,
    worktreePath,
    command,
    commandArgs,
    initialized: false,
    replayRequested: false,
    opened: false,
    readyForOutput: renderer !== 'ghostty-web',
    outputReadyPromise: renderer === 'ghostty-web' ? null : Promise.resolve(),
    pendingOutput: [],
    lastAppearance: null,
    appearanceLoadVersion: 0,
    appearanceResizeTimer: null,
    touchScrollCleanup: null,
    compositionGuardCleanup: null,
  }

  // Apply any pending onStopped callback registered before creation
  const pendingCb = pendingOnStopped.get(terminalId)
  if (pendingCb) {
    instance.onStopped = pendingCb
    pendingOnStopped.delete(terminalId)
  }

  instances.set(terminalId, instance)
  return instance
}

/**
 * Get terminal instance by ID.
 */
export function getInstance(
  terminalId: string
): PersistentTerminal | undefined {
  return instances.get(terminalId)
}

/**
 * Attach terminal to a DOM container.
 * If first attach, calls terminal.open(). Otherwise moves DOM element.
 * Starts PTY if not already initialized.
 */
export async function attachToContainer(
  terminalId: string,
  container: HTMLDivElement
): Promise<void> {
  const instance = instances.get(terminalId)
  if (!instance) {
    console.error(
      '[terminal-instances] attachToContainer: instance not found:',
      terminalId
    )
    return
  }

  const terminal = await ensureTerminalCreated(terminalId, instance)
  const fitAddon = instance.fitAddon
  if (!terminal || !fitAddon) {
    return
  }

  const { worktreePath, command, commandArgs } = instance

  terminal.options.theme = getTerminalTheme()

  if (!instance.hostElement) {
    instance.hostElement = document.createElement('div')
    instance.hostElement.className = 'h-full w-full overflow-hidden'
    instance.hostElement.dataset.terminalEmulator = instance.renderer
  }

  const hostElement = instance.hostElement
  if (hostElement.parentNode !== container) {
    if (hostElement.parentNode) {
      hostElement.parentNode.removeChild(hostElement)
    }
    container.replaceChildren(hostElement)
  }

  const wasOpened = instance.opened
  if (!wasOpened) {
    terminal.open(hostElement)
    disableGhosttyScrollbar(instance)
    instance.touchScrollCleanup = attachTouchScroll(instance)
    // Re-run-safe: drop any prior guard before (re)attaching so a reattach
    // can never leak listeners on a stale host or register duplicates.
    instance.compositionGuardCleanup?.()
    instance.compositionGuardCleanup = null
    if (instance.renderer === 'xterm') {
      // WebKitGTK+ibus commits composed chars (é, ç…) without
      // compositionstart, which breaks xterm.js's composition handling and
      // duplicates input — see terminal-composition-guard.ts. The guard
      // swallows the orphan compositionend and delivers the committed char
      // itself, bypassing xterm's racy keydown-diff path.
      const xterm = terminal as XtermTerminal
      instance.compositionGuardCleanup = attachOrphanCompositionEndGuard(
        hostElement,
        data => xterm.input(data, true)
      )
    }
    if (!instance.initialized) {
      // A brand-new visible terminal should never show stale renderer/DOM
      // contents from a previously attached terminal. Do not clear when a PTY
      // was started headlessly: its buffered output is real session output.
      clearFreshTerminalDisplay(instance)
    }
    void scheduleGhosttyOutputReady(instance)
    instance.opened = true
  }

  // Fit terminal to container and start/reattach PTY
  scheduleAnimationFrame(async () => {
    if (!isCurrentInstance(terminalId, instance)) return

    fitAddon.fit()
    // Enforce minimum dimensions — degenerate sizes (e.g. rows=0 during dialog
    // animation) cause portable_pty to crash with an internal assertion failure.
    const rawCols = terminal.cols
    const rawRows = terminal.rows
    const { cols, rows } = getSafeTerminalDimensions(terminal)
    console.log(
      `[terminal-instances] attachToContainer ${terminalId}: fit=${rawCols}x${rawRows} → used=${cols}x${rows}, initialized=${instance.initialized}, container=${container.clientWidth}x${container.clientHeight}`
    )

    if (!(await waitForTerminalReady(terminalId, instance))) return

    if (!instance.initialized) {
      // First time - check if PTY already exists (reattaching after app restart)
      const ptyExists = await invoke<boolean>('has_active_terminal', {
        terminalId,
      })
      if (!isCurrentInstance(terminalId, instance)) return

      if (ptyExists) {
        // PTY exists - replay buffered output, then resize and mark as running.
        // This is the web-refresh reattach path: the Rust PTY survived, but
        // the browser lost its in-memory xterm instance and seq tracking.
        if (!instance.replayRequested) {
          instance.replayRequested = true
          requestTerminalReplay(terminalId, 0)
        }
        useTerminalStore.getState().setTerminalRunning(terminalId, true)
        await invoke('terminal_resize', { terminalId, cols, rows }).catch(
          console.error
        )
      } else {
        // Start new PTY process
        await invoke('start_terminal', {
          terminalId,
          worktreePath,
          cols,
          rows,
          command,
          commandArgs,
        }).catch(error => {
          console.error('[terminal-instances] start_terminal failed:', error)
          terminal.writeln(`\x1b[31mFailed to start terminal: ${error}\x1b[0m`)
        })
      }
      if (!isCurrentInstance(terminalId, instance)) return

      instance.initialized = true
    } else {
      // Already initialized - just resize
      await invoke('terminal_resize', { terminalId, cols, rows }).catch(
        console.error
      )
    }

    terminal.focus()
  })
}

/**
 * Start a terminal PTY without attaching to DOM.
 * Creates the embedded terminal instance (for event listeners + output
 * buffering) and spawns the PTY immediately. When the user later opens the
 * session, attachToContainer detects and reattaches to the running PTY.
 */
export function startHeadless(
  terminalId: string,
  options: {
    worktreeId: string
    worktreePath: string
    command: string
    commandArgs?: string[] | null
  }
): void {
  const instance = getOrCreateTerminal(terminalId, options)
  if (instance.initialized) return // Already started

  ensureTerminalCreated(terminalId, instance)
    .then(async terminal => {
      if (!terminal) return
      if (!(await waitForTerminalReady(terminalId, instance))) return
      instance.initialized = true
      return invoke('start_terminal', {
        terminalId,
        worktreePath: options.worktreePath,
        cols: 80,
        rows: 24,
        command: options.command,
        commandArgs: options.commandArgs ?? null,
      })
    })
    .catch(error => {
      console.error(
        '[terminal-instances] headless start_terminal failed:',
        error
      )
    })
}

/**
 * Detach terminal from DOM container.
 * Terminal stays in memory with preserved buffer.
 */
export function detachFromContainer(terminalId: string): void {
  const instance = instances.get(terminalId)
  if (!instance) return

  const hostElement = instance.hostElement
  if (hostElement?.parentNode) {
    hostElement.parentNode.removeChild(hostElement)
  }
}

/**
 * Fit terminal to its container dimensions.
 */
export function fitTerminal(terminalId: string): void {
  const instance = instances.get(terminalId)
  if (!instance || !instance.fitAddon || !instance.terminal) return

  instance.fitAddon.fit()
  const { cols, rows } = getSafeTerminalDimensions(instance.terminal)
  invoke('terminal_resize', { terminalId, cols, rows }).catch(console.error)
}

/**
 * Focus terminal for keyboard input.
 */
export function focusTerminal(terminalId: string): void {
  const instance = instances.get(terminalId)
  if (!instance || !instance.terminal) return

  instance.terminal.focus()
}

/**
 * Dispose a single terminal instance.
 * Cleans up event listeners, disposes xterm, removes from Map.
 * Does NOT stop PTY - caller should do that separately.
 */
export async function disposeTerminal(terminalId: string): Promise<void> {
  const instance = instances.get(terminalId)
  if (!instance) return

  // Remove from Map first so new lookups don't find a half-disposed instance
  instances.delete(terminalId)
  discardTerminalInput(terminalId)
  outputBuffers.delete(terminalId)
  instance.pendingOutput = []
  instance.readyForOutput = false
  instance.outputReadyPromise = null
  pendingOnStopped.delete(terminalId)
  instance.appearanceLoadVersion += 1
  if (instance.appearanceResizeTimer) {
    clearTimeout(instance.appearanceResizeTimer)
    instance.appearanceResizeTimer = null
  }
  instance.touchScrollCleanup?.()
  instance.touchScrollCleanup = null
  instance.compositionGuardCleanup?.()
  instance.compositionGuardCleanup = null

  // Dispose terminal renderer (clears buffer, removes DOM)
  instance.terminal?.dispose()
  instance.hostElement?.remove()
}

/**
 * Dispose all terminals for a worktree.
 * Used when worktree is deleted/archived/closed.
 * Stops PTY processes and cleans up embedded terminal instances.
 */
export function disposeAllWorktreeTerminals(worktreeId: string): void {
  // Get terminal IDs from store and clear store state
  const terminalIds = useTerminalStore.getState().closeAllTerminals(worktreeId)

  // Dispose each terminal instance and stop PTY
  for (const terminalId of terminalIds) {
    // Stop PTY process
    invoke('stop_terminal', { terminalId }).catch(() => {
      // Terminal may already be stopped
    })

    // Dispose xterm instance
    disposeTerminal(terminalId)
  }
}

/**
 * Dispose only side/drawer panel terminals for a worktree.
 * Session-owned full-screen terminals are intentionally preserved.
 */
export function disposePanelWorktreeTerminals(worktreeId: string): void {
  const terminalIds = useTerminalStore
    .getState()
    .closePanelTerminals(worktreeId)

  for (const terminalId of terminalIds) {
    invoke('stop_terminal', { terminalId }).catch(() => {
      // Terminal may already be stopped
    })

    disposeTerminal(terminalId)
  }
}

/**
 * Check if a terminal instance exists.
 */
export function hasInstance(terminalId: string): boolean {
  return instances.has(terminalId)
}

/**
 * Register a callback for when a terminal's process exits.
 * Can be called before or after terminal creation.
 */
export function setOnStopped(
  terminalId: string,
  cb: ((exitCode: number | null, signal: string | null) => void) | undefined
): void {
  const instance = instances.get(terminalId)
  if (instance) {
    instance.onStopped = cb
  }
  if (cb) {
    pendingOnStopped.set(terminalId, cb)
  } else {
    pendingOnStopped.delete(terminalId)
  }
}
