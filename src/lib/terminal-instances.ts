/**
 * Module-level storage for xterm.js Terminal instances.
 *
 * This decouples terminal lifecycle from React component lifecycle.
 * Terminals persist across component mount/unmount cycles, preserving
 * buffer content, cursor position, and running processes.
 *
 * Only disposed when user explicitly closes the terminal.
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { openExternal } from '@/lib/platform'
import { invoke } from '@/lib/transport'
import { listen, type UnlistenFn } from '@/lib/transport'
import { useTerminalStore } from '@/store/terminal-store'
import type {
  TerminalOutputEvent,
  TerminalStartedEvent,
  TerminalStoppedEvent,
} from '@/types/terminal'

interface PersistentTerminal {
  terminal: Terminal
  fitAddon: FitAddon
  listeners: UnlistenFn[]
  worktreeId: string
  worktreePath: string
  command: string | null
  commandArgs: string[] | null
  initialized: boolean // PTY has been started
  onStopped?: (exitCode: number | null, signal: string | null) => void
}

// Module-level Map - persists across React mount/unmount cycles
const instances = new Map<string, PersistentTerminal>()

// TODO: Add memory cap for detached terminals (e.g., 20 max)
// For now, typical usage won't hit memory limits

/**
 * Get existing terminal instance or create a new one.
 * Creates xterm.js Terminal, FitAddon, and event listeners.
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
    return existing
  }

  const {
    worktreeId,
    worktreePath,
    command = null,
    commandArgs = null,
  } = options
  const { setTerminalRunning } = useTerminalStore.getState()

  // Create xterm.js Terminal instance
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
    theme: {
      background: '#1a1a1a',
      foreground: '#e5e5e5',
      cursor: '#e5e5e5',
      selectionBackground: '#404040',
    },
    allowProposedApi: true,
  })

  // Block most app shortcuts when terminal is focused. Only let specific CMD
  // combos bubble to the global handler for terminal-specific actions.
  // Ctrl+C/D/Z/L etc. always reach the PTY for terminal signal handling.
  terminal.attachCustomKeyEventHandler(event => {
    if (event.metaKey) {
      const code = event.code
      // CMD+` → toggle terminal panel
      if (code === 'Backquote') return false
      // CMD+T → new terminal tab
      if (!event.shiftKey && !event.altKey && code === 'KeyT') return false
      // CMD+W → close terminal tab
      if (!event.shiftKey && !event.altKey && code === 'KeyW') return false
      // CMD+1..9 → switch terminal tab
      if (!event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(code)) {
        return false
      }
      // CMD+Alt+Backspace → cancel prompt
      if (event.altKey && (code === 'Backspace' || code === 'Delete'))
        return false
      // All other CMD shortcuts: xterm consumes them (prevents app actions)
      return true
    }
    return true
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(
    new WebLinksAddon((_event, uri) => {
      openExternal(uri)
    })
  )

  // Handle user input - forward to PTY
  terminal.onData(data => {
    invoke('terminal_write', { terminalId, data }).catch(console.error)
  })

  const listeners: UnlistenFn[] = []

  // Setup event listeners ONCE when terminal is created
  // These persist for the lifetime of the terminal instance
  listen<TerminalOutputEvent>('terminal:output', event => {
    if (event.payload.terminal_id === terminalId) {
      terminal.write(event.payload.data)
    }
  }).then(unlisten => listeners.push(unlisten))

  listen<TerminalStartedEvent>('terminal:started', event => {
    if (event.payload.terminal_id === terminalId) {
      setTerminalRunning(terminalId, true)
    }
  }).then(unlisten => listeners.push(unlisten))

  listen<TerminalStoppedEvent>('terminal:stopped', event => {
    if (event.payload.terminal_id === terminalId) {
      setTerminalRunning(terminalId, false)
      const exitCode = event.payload.exit_code
      const signal = event.payload.signal
      const exitLabel =
        signal != null ? `signal ${signal}` : `code ${exitCode ?? 'unknown'}`
      terminal.writeln(`\r\n\x1b[90m[Process exited with ${exitLabel}]\x1b[0m`)
      const inst = instances.get(terminalId)
      inst?.onStopped?.(exitCode, signal)

      // Auto-close terminal tab on:
      // 1. Successful exit (code 0) — any terminal
      // 2. SIGINT (Ctrl+C) — only for "run" terminals (have a command)
      const isInterrupt = signal != null && signal.includes('Interrupt')
      const isRunTerminal = inst?.command != null
      if (inst && (exitCode === 0 || (isInterrupt && isRunTerminal))) {
        const wId = inst.worktreeId
        setTimeout(() => {
          if (!instances.has(terminalId)) return // Already disposed
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          invoke('stop_terminal', { terminalId }).catch(() => {})
          disposeTerminal(terminalId)
          const { removeTerminal, setTerminalPanelOpen } =
            useTerminalStore.getState()
          removeTerminal(wId, terminalId)
          const remaining = useTerminalStore.getState().terminals[wId] ?? []
          if (remaining.length === 0) {
            setTerminalPanelOpen(wId, false)
            useTerminalStore.getState().setTerminalVisible(false)
            useTerminalStore.getState().setModalTerminalOpen(wId, false)
          }
        }, 0)
      }
    }
  }).then(unlisten => listeners.push(unlisten))

  const instance: PersistentTerminal = {
    terminal,
    fitAddon,
    listeners,
    worktreeId,
    worktreePath,
    command,
    commandArgs,
    initialized: false,
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

  const {
    terminal,
    fitAddon,
    worktreePath,
    command,
    commandArgs,
    initialized,
  } = instance
  const terminalElement = terminal.element

  if (!terminalElement) {
    // First attach - call open() to create DOM element
    terminal.open(container)
  } else if (terminalElement.parentNode !== container) {
    // Re-attach - move DOM element to new container
    container.appendChild(terminalElement)
  }

  // Fit terminal to container and start/reconnect PTY
  requestAnimationFrame(async () => {
    fitAddon.fit()
    // Enforce minimum dimensions — degenerate sizes (e.g. rows=0 during dialog
    // animation) cause portable_pty to crash with an internal assertion failure.
    const rawCols = terminal.cols
    const rawRows = terminal.rows
    let cols = rawCols < 2 ? 80 : rawCols
    let rows = rawRows < 2 ? 24 : rawRows
    console.log(
      `[terminal-instances] attachToContainer ${terminalId}: fit=${rawCols}x${rawRows} → used=${cols}x${rows}, initialized=${initialized}, container=${container.clientWidth}x${container.clientHeight}`
    )

    if (!initialized) {
      // First time - check if PTY already exists (reconnecting after app restart)
      const ptyExists = await invoke<boolean>('has_active_terminal', {
        terminalId,
      })

      if (ptyExists) {
        // PTY exists - just resize and mark as running
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
 * Creates the xterm instance (for event listeners + output buffering) and spawns
 * the PTY immediately. When the user later opens the session, attachToContainer
 * will detect the running PTY via has_active_terminal and reconnect.
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

  instance.initialized = true
  invoke('start_terminal', {
    terminalId,
    worktreePath: options.worktreePath,
    cols: 80,
    rows: 24,
    command: options.command,
    commandArgs: options.commandArgs ?? null,
  }).catch(error => {
    console.error('[terminal-instances] headless start_terminal failed:', error)
  })
}

/**
 * Detach terminal from DOM container.
 * Terminal stays in memory with preserved buffer.
 */
export function detachFromContainer(terminalId: string): void {
  const instance = instances.get(terminalId)
  if (!instance) return

  const terminalElement = instance.terminal.element
  if (terminalElement?.parentNode) {
    terminalElement.parentNode.removeChild(terminalElement)
  }
}

/**
 * Fit terminal to its container dimensions.
 */
export function fitTerminal(terminalId: string): void {
  const instance = instances.get(terminalId)
  if (!instance) return

  instance.fitAddon.fit()
  const { cols, rows } = instance.terminal
  invoke('terminal_resize', { terminalId, cols, rows }).catch(console.error)
}

/**
 * Focus terminal for keyboard input.
 */
export function focusTerminal(terminalId: string): void {
  const instance = instances.get(terminalId)
  if (!instance) return

  instance.terminal.focus()
}

/**
 * Dispose a single terminal instance.
 * Cleans up event listeners, disposes xterm, removes from Map.
 * Does NOT stop PTY - caller should do that separately.
 */
export function disposeTerminal(terminalId: string): void {
  const instance = instances.get(terminalId)
  if (!instance) return

  // Cleanup event listeners
  for (const unlisten of instance.listeners) {
    unlisten()
  }

  // Dispose xterm.js (clears buffer, removes DOM)
  instance.terminal.dispose()

  // Remove from Map
  instances.delete(terminalId)
}

/**
 * Dispose all terminals for a worktree.
 * Used when worktree is deleted/archived/closed.
 * Stops PTY processes and cleans up xterm instances.
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
 * Check if a terminal instance exists.
 */
export function hasInstance(terminalId: string): boolean {
  return instances.has(terminalId)
}

// Pending onStopped callbacks for terminals not yet created
const pendingOnStopped = new Map<
  string,
  (exitCode: number | null, signal: string | null) => void
>()

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
