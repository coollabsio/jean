import { toast } from 'sonner'
import { invoke, invokeForOptionalServer } from '@/lib/transport'
import { generateId } from '@/lib/uuid'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { parseServerResourceKey } from '@/lib/server-resource'
import { formatMagicPromptForPty } from '@/lib/magic-prompt-pty'
import {
  startHeadless,
  terminalAcceptsBracketedPaste,
} from '@/lib/terminal-instances'
import {
  NATIVE_CLI_COMMANDS,
  NATIVE_CLI_YOLO_ARGS,
} from '@/lib/native-cli-session'
import { getBackendPlainLabel } from '@/components/ui/backend-label'
import { chatQueryKeys } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import type { ExecutionMode, Session } from '@/types/chat'
import type { CliBackend, NewSessionKind } from '@/types/preferences'

/**
 * Magic prompts and investigations that open a NEW session follow the
 * `default_new_session_kind` preference (the same one CMD+T uses):
 * - `chat`: Jean Chat (the caller keeps its normal send path).
 * - a CLI backend: that backend's native CLI in a terminal session.
 * - `terminal`: a plain shell cannot run a prompt, so the magic prompt's own
 *   backend runs in a terminal session.
 *
 * The prompt is typed into the CLI after it starts, like a Magic prompt sent
 * to a running terminal session. It is not a command-line argument, so it is
 * never shell-parsed and is not saved in the session's resume arguments.
 */
export type MagicPromptSessionTarget =
  | { surface: 'chat' }
  | { surface: 'terminal'; backend: CliBackend; commandArgs: string[] }

/**
 * Native CLI start flags for a Jean execution mode, or null when the CLI has
 * no native equivalent (the prompt then stays in Jean Chat).
 */
function nativeArgsForExecutionMode(
  backend: CliBackend,
  executionMode: ExecutionMode
): string[] | null {
  if (executionMode === 'yolo') return NATIVE_CLI_YOLO_ARGS[backend] ?? []
  if (executionMode === 'plan') {
    // https://code.claude.com/docs/en/permission-modes
    return backend === 'claude' ? ['--permission-mode', 'plan'] : null
  }
  return []
}

export function resolveMagicPromptSessionTarget({
  newSessionKind,
  promptBackend,
  executionMode,
}: {
  newSessionKind: NewSessionKind | null | undefined
  promptBackend: CliBackend
  executionMode: ExecutionMode
}): MagicPromptSessionTarget {
  const kind = newSessionKind ?? 'chat'
  if (kind === 'chat') return { surface: 'chat' }
  const backend = kind === 'terminal' ? promptBackend : kind
  const commandArgs = nativeArgsForExecutionMode(backend, executionMode)
  if (!commandArgs) return { surface: 'chat' }
  return { surface: 'terminal', backend, commandArgs }
}

const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 200

/**
 * Write the prompt when the CLI is ready for input: its PTY runs and it has
 * turned on bracketed paste. A CLI that never turns it on gets the prompt
 * as plain input after the timeout.
 */
async function writePromptWhenReady(
  terminalId: string,
  prompt: string
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const isRunning = () =>
    useTerminalStore.getState().isTerminalRunning(terminalId)
  while (Date.now() < deadline) {
    if (isRunning() && terminalAcceptsBracketedPaste(terminalId)) break
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
  }
  if (!isRunning()) {
    toast.error('The terminal session did not start', {
      description: 'The Magic prompt was not sent.',
    })
    return
  }
  const data = formatMagicPromptForPty(
    prompt,
    terminalAcceptsBracketedPaste(terminalId)
  )
  try {
    await invoke('terminal_write', { terminalId, data })
  } catch (error) {
    toast.error(`Could not send the Magic prompt to the terminal: ${error}`)
  }
}

/**
 * Open a new session for a magic prompt in a native CLI terminal when the
 * `default_new_session_kind` preference asks for one.
 *
 * Returns the new terminal session; the caller then opens it as it opens a
 * chat session. Returns null when the prompt must use Jean Chat: the
 * preference is `chat`, the execution mode has no native equivalent, or the
 * CLI is not installed. `prepare` runs after the session exists and before
 * the CLI starts (for example, to attach loaded context).
 */
export async function openMagicPromptInTerminal({
  newSessionKind,
  worktreeId,
  worktreePath,
  name,
  prompt,
  promptBackend,
  executionMode,
  prepare,
}: {
  /** The `default_new_session_kind` preference. */
  newSessionKind: NewSessionKind | null | undefined
  worktreeId: string
  worktreePath: string
  name: string
  prompt: string
  promptBackend: CliBackend
  executionMode: ExecutionMode
  prepare?: (sessionId: string) => Promise<unknown>
}): Promise<Session | null> {
  const target = resolveMagicPromptSessionTarget({
    newSessionKind,
    promptBackend,
    executionMode,
  })
  if (target.surface === 'chat') return null

  const serverId =
    parseServerResourceKey(worktreeId)?.serverId ?? LOCAL_SERVER_ID

  const { backend } = target
  const label = getBackendPlainLabel(backend)
  const status = await invokeForOptionalServer<{
    installed?: boolean
    path?: string | null
  }>(
    serverId === LOCAL_SERVER_ID ? undefined : serverId,
    `check_${backend}_cli_installed`
  ).catch(() => null)
  if (!status?.installed) {
    toast.info(`${label} CLI is not installed. Using Jean Chat.`)
    return null
  }
  const command = status.path ?? NATIVE_CLI_COMMANDS[backend]

  // Claude and Pi accept a caller-chosen session id; the others report theirs
  // through native session tracking.
  const nativeSessionId =
    backend === 'claude' || backend === 'pi' ? generateId() : undefined
  const savedArgs = nativeSessionId
    ? [...target.commandArgs, '--session-id', nativeSessionId]
    : target.commandArgs

  const session = await invoke<Session>('create_session', {
    worktreeId,
    worktreePath,
    name,
    backend,
    primarySurface: 'terminal',
    terminalCommand: command,
    terminalCommandArgs: savedArgs,
    terminalLabel: label,
    nativeSessionId,
  })

  if (prepare) {
    await prepare(session.id).catch(error =>
      logger.error('Failed to prepare magic prompt session', { error })
    )
  }

  const contextArgs = await invoke<{ commandArgs: string[] }>(
    'prepare_backend_terminal_context',
    { sessionId: session.id, worktreeId, backend }
  )
    .then(prepared => prepared.commandArgs)
    .catch(error => {
      logger.error('Failed to prepare backend terminal context', { error })
      return []
    })

  if (backend === 'codex' || backend === 'opencode' || backend === 'cursor') {
    await invoke('track_native_cli_session', {
      worktreePath,
      sessionId: session.id,
      backend,
    }).catch(error =>
      logger.error('Failed to start native CLI session tracking', { error })
    )
  }

  const commandArgs = [...savedArgs, ...contextArgs]
  const terminalId = useTerminalStore
    .getState()
    .addTerminal(worktreeId, command, label, {
      kind: 'session',
      commandArgs,
      activate: false,
      openPanel: false,
      sessionId: session.id,
    })
  // Start the CLI now, so a session that is not on screen (separate
  // investigations) still gets its prompt. Opening it reattaches.
  startHeadless(terminalId, {
    worktreeId,
    worktreePath,
    command,
    commandArgs,
    sessionId: session.id,
  })

  const ui = useUIStore.getState()
  ui.setSessionPrimarySurface(session.id, 'terminal')
  ui.setSessionTerminalId(session.id, terminalId)
  const chat = useChatStore.getState()
  chat.registerWorktreePath(worktreeId, worktreePath)
  chat.setSelectedBackend(session.id, backend)
  chat.setActiveSession(worktreeId, session.id)
  queryClient.setQueryData(chatQueryKeys.session(session.id), session)
  void queryClient.invalidateQueries({
    queryKey: chatQueryKeys.sessions(worktreeId),
  })

  void writePromptWhenReady(terminalId, prompt)
  return session
}
