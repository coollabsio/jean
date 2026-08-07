import { invoke, listen } from '@/lib/transport'
import { generateId } from '@/lib/uuid'
import { logger } from '@/lib/logger'
import { isServerWindows } from '@/lib/platform'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import type { CliBackend } from '@/types/preferences'
import type { Session } from '@/types/chat'
import type { TerminalStartedEvent } from '@/types/terminal'

/**
 * Launching a magic prompt as a native CLI session in an embedded terminal,
 * instead of the Jean Chat headless runner.
 *
 * The prompt normally rides along as a positional argument at spawn, which is
 * race-free and survives session resume because it is persisted in the session's
 * `terminal_command_args`. Three situations make that unsafe or impossible, and
 * each falls back to writing the prompt into the PTY once it is running —
 * see `planPromptDelivery`.
 */

/** Permission-bypass flags, as global flags that must precede any subcommand. */
export const YOLO_ARGS_BY_BACKEND: Partial<Record<CliBackend, string[]>> = {
  claude: ['--permission-mode', 'bypassPermissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  cursor: ['--yolo', '--sandbox', 'disabled'],
  grok: ['--always-approve', '--sandbox', 'off'],
  kimi: ['--yolo'],
}

/**
 * Args that carry an initial prompt, per backend.
 *
 * Backends absent from this map have no verified positional-prompt support and
 * take the write path instead. Guessing a flag here would silently start a
 * review with the prompt swallowed as an unknown argument.
 */
const PROMPT_ARGS_BY_BACKEND: Partial<
  Record<CliBackend, (prompt: string) => string[]>
> = {
  // Auto-submits into the interactive TUI.
  claude: prompt => [prompt],
  codex: prompt => [prompt],
  cursor: prompt => [prompt],
  // Pre-fills the composer but does NOT submit, so it needs a trailing Enter.
  opencode: prompt => ['--prompt', prompt],
}

/** Backends whose prompt arg lands in the composer without being sent. */
const NEEDS_SUBMIT_KEY: ReadonlySet<CliBackend> = new Set<CliBackend>([
  'opencode',
])

/**
 * Beyond this, a prompt is delivered by writing rather than on argv.
 *
 * Windows caps a whole command line near 32k; the diff-bearing prompts here can
 * approach that, and truncation would be silent.
 */
export const MAX_ARGV_PROMPT_CHARS = 8000

/**
 * Characters that `cmd.exe /C` mangles or interprets.
 *
 * Only consulted for Windows batch shims. Native `.exe` invocation and WSL both
 * pass argv straight through, and Unix single-quote escapes the whole string.
 */
const CMD_HOSTILE_PATTERN = /[\r\n&|^<>]/

export type PromptWriteReason =
  | 'unsupported-backend'
  | 'prompt-too-long'
  | 'windows-shim'

export interface PromptDelivery {
  /** How the prompt reaches the CLI. */
  via: 'argv' | 'write'
  /** Prompt-bearing args, appended after yolo/session args. Empty when writing. */
  promptArgs: string[]
  /** Text to write into the PTY once running, or null when nothing is needed. */
  pendingWrite: string | null
  /** Why the write path was chosen. Null on the argv path. */
  writeReason: PromptWriteReason | null
}

/** True for `.cmd`/`.bat` shims, which jean-core runs through `cmd.exe /C`. */
export function isWindowsShimCommand(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command.trim())
}

/**
 * Decide how a prompt should reach a terminal-launched CLI.
 *
 * `serverIsWindows` is injected rather than read from the platform module so the
 * decision is testable, and because the PTY runs on the Jean server, which may
 * be a different OS than the client.
 */
export function planPromptDelivery({
  backend,
  command,
  prompt,
  serverIsWindows,
}: {
  backend: CliBackend
  command: string
  prompt: string
  serverIsWindows: boolean
}): PromptDelivery {
  const write = (reason: PromptWriteReason): PromptDelivery => ({
    via: 'write',
    promptArgs: [],
    // Trailing carriage return submits the prompt the same way typing it would.
    pendingWrite: `${prompt}\r`,
    writeReason: reason,
  })

  const buildArgs = PROMPT_ARGS_BY_BACKEND[backend]
  if (!buildArgs) return write('unsupported-backend')

  if (prompt.length > MAX_ARGV_PROMPT_CHARS) return write('prompt-too-long')

  // jean-core routes Windows batch shims through `cmd.exe /C`, whose quoting
  // cannot carry newlines or shell metacharacters intact.
  if (
    serverIsWindows &&
    isWindowsShimCommand(command) &&
    CMD_HOSTILE_PATTERN.test(prompt)
  ) {
    return write('windows-shim')
  }

  return {
    via: 'argv',
    promptArgs: buildArgs(prompt),
    pendingWrite: NEEDS_SUBMIT_KEY.has(backend) ? '\r' : null,
    writeReason: null,
  }
}

/**
 * Full argument list for a magic-prompt terminal launch.
 *
 * Order matters: permission flags are global and must precede any subcommand or
 * positional prompt, and Claude's `--session-id` must be paired with the id we
 * persist so the session can later be resumed.
 */
export function buildMagicPromptCommandArgs({
  backend,
  delivery,
  yolo,
  nativeSessionId,
  modelArgs = [],
}: {
  backend: CliBackend
  delivery: PromptDelivery
  yolo: boolean
  nativeSessionId?: string
  /** From `resolve_terminal_model_args`; empty means "use the CLI default". */
  modelArgs?: string[]
}): string[] {
  const args: string[] = []
  if (yolo) args.push(...(YOLO_ARGS_BY_BACKEND[backend] ?? []))
  if (backend === 'claude' && nativeSessionId) {
    args.push('--session-id', nativeSessionId)
  }
  args.push(...modelArgs)
  args.push(...delivery.promptArgs)
  return args
}

/**
 * Ask the backend which `--model` args this CLI needs.
 *
 * Normalization lives in Rust because each backend's rules are non-obvious
 * (opencode keeps its `opencode/` prefix when opencode *is* the provider, codex
 * remaps fast variants, grok maps retired ids forward) and are already
 * implemented there for headless runs. A second copy here would drift.
 */
async function resolveModelArgs(
  backend: CliBackend,
  model: string | undefined
): Promise<string[]> {
  if (!model) return []
  try {
    return await invoke<string[]>('resolve_terminal_model_args', {
      backend,
      model,
    })
  } catch (error) {
    // A wrong model is better than no session, but say so.
    logger.warn('Could not resolve terminal model args; using CLI default', {
      backend,
      model,
      error,
    })
    return []
  }
}

/** How long to wait for the PTY before giving up on a pending write. */
const TERMINAL_START_TIMEOUT_MS = 30_000

/**
 * Resolve once the terminal's PTY is running.
 *
 * Checks the store first: `terminal:started` is a global listener that flips
 * `runningTerminals`, so a terminal can already be up before we subscribe.
 */
async function waitForTerminalStart(terminalId: string): Promise<boolean> {
  if (useTerminalStore.getState().isTerminalRunning(terminalId)) return true

  return new Promise<boolean>(resolve => {
    let settled = false
    let unlisten: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (started: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unlisten?.()
      resolve(started)
    }

    timer = setTimeout(() => finish(false), TERMINAL_START_TIMEOUT_MS)

    void listen<TerminalStartedEvent>('terminal:started', event => {
      if (event.payload.terminal_id === terminalId) finish(true)
    }).then(dispose => {
      if (settled) {
        dispose()
        return
      }
      unlisten = dispose
      // Re-check: the PTY may have started between the initial check and here.
      if (useTerminalStore.getState().isTerminalRunning(terminalId)) finish(true)
    })
  })
}

/**
 * Create a session without the React Query mutation.
 *
 * For callers outside the React tree (background investigation). Hook callers
 * should pass `useCreateSession().mutateAsync` instead so the session list cache
 * updates immediately.
 */
export async function createSessionViaInvoke(args: {
  worktreeId: string
  worktreePath: string
  name?: string
  backend?: NonNullable<Session['backend']>
  primarySurface?: Session['primary_surface']
  terminalCommand?: string | null
  terminalCommandArgs?: string[]
  terminalLabel?: string
  nativeSessionId?: string
}): Promise<Session> {
  return invoke<Session>('create_session', args)
}

export interface LaunchMagicPromptTerminalParams {
  prompt: string
  backend: CliBackend
  /** Resolved CLI binary path, or a bare name from `BACKEND_COMMANDS`. */
  command: string
  worktreeId: string
  worktreePath: string
  /** Terminal tab label, e.g. "Code Review". */
  label: string
  /** Magic-prompt model for this operation; normalized backend-side. */
  model?: string
  /** Whether to launch with the backend's permission-bypass flags. */
  yolo?: boolean
  /** Injected so this module stays hook-free and unit-testable. */
  createSession: (args: {
    worktreeId: string
    worktreePath: string
    name?: string
    backend?: NonNullable<Session['backend']>
    primarySurface?: Session['primary_surface']
    terminalCommand?: string | null
    terminalCommandArgs?: string[]
    terminalLabel?: string
    nativeSessionId?: string
  }) => Promise<Session>
}

export interface LaunchMagicPromptTerminalResult {
  sessionId: string
  terminalId: string
  delivery: PromptDelivery
}

/**
 * Run a magic prompt as a native CLI session in an embedded terminal.
 *
 * Mirrors the launch sequence in `NativeCliSessionsModal`, with the prompt
 * folded in. Returns once the session and terminal exist; a pending write is
 * awaited so callers know the prompt actually reached the CLI.
 */
export async function launchMagicPromptTerminal({
  prompt,
  backend,
  command,
  worktreeId,
  worktreePath,
  label,
  model,
  yolo = false,
  createSession,
}: LaunchMagicPromptTerminalParams): Promise<LaunchMagicPromptTerminalResult> {
  const delivery = planPromptDelivery({
    backend,
    command,
    prompt,
    serverIsWindows: isServerWindows(),
  })

  if (delivery.writeReason) {
    logger.info('Magic prompt terminal falling back to PTY write', {
      backend,
      reason: delivery.writeReason,
    })
  }

  // Claude needs its session id chosen up front so the session can be resumed.
  const nativeSessionId = backend === 'claude' ? generateId() : undefined
  const modelArgs = await resolveModelArgs(backend, model)
  const commandArgs = buildMagicPromptCommandArgs({
    backend,
    delivery,
    yolo,
    nativeSessionId,
    modelArgs,
  })

  const session = await createSession({
    worktreeId,
    worktreePath,
    name: label,
    backend,
    primarySurface: 'terminal',
    terminalCommand: command,
    terminalCommandArgs: commandArgs,
    terminalLabel: label,
    nativeSessionId,
  })

  const terminalId = useTerminalStore
    .getState()
    .addTerminal(worktreeId, command, label, {
      kind: 'session',
      commandArgs,
      activate: false,
      openPanel: false,
      sessionId: session.id,
    })

  const uiStore = useUIStore.getState()
  uiStore.setSessionPrimarySurface(session.id, 'terminal')
  uiStore.setSessionTerminalId(session.id, terminalId)

  const chatStore = useChatStore.getState()
  chatStore.setActiveSession(worktreeId, session.id)
  chatStore.setSelectedBackend(session.id, backend)

  if (delivery.pendingWrite) {
    const started = await waitForTerminalStart(terminalId)
    if (started) {
      try {
        await invoke('terminal_write', {
          terminalId,
          data: delivery.pendingWrite,
        })
      } catch (error) {
        logger.error('Failed to write magic prompt into terminal', {
          terminalId,
          error,
        })
      }
    } else {
      logger.error('Terminal never started; magic prompt was not delivered', {
        terminalId,
        backend,
      })
    }
  }

  return { sessionId: session.id, terminalId, delivery }
}
