import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { terminalAcceptsBracketedPaste } from '@/lib/terminal-instances'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'

/**
 * Magic prompts that are sent into the *current* session.
 *
 * Routed into the open native CLI PTY when that session's primary surface is
 * `terminal` and the PTY is still running:
 * - Check GitHub Issues
 * - Commit This Session
 * - Comment & Close Issue
 * - Pre-release Review
 * - Investigate (issue, PR, advisory, and the Sentry/Linear/security variants
 *   that send into the active session)
 *
 * Left on their existing paths because they create or operate on something
 * other than the current session's prompt:
 * - Save Context, Inject Context, Linked Projects, Fork Session
 * - Commit, Commit & Push, Revert, Pull, Push, Sync
 * - Create/Open PR, Link PR, Generate PR Description, Review, PR Comments,
 *   Merge PR
 * - Generate Release Notes
 * - Merge to Base, Resolve Conflicts
 * - Investigate a workflow run (opens a new session)
 */

const BRACKETED_PASTE_START = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'

export type MagicPromptRoute = 'chat' | 'pty' | 'exited'

/**
 * Bytes written to the PTY for a rendered magic prompt.
 *
 * When the program has enabled bracketed paste, newlines are carriage returns
 * inside CSI 200~ … CSI 201~ so the CLI treats them as one paste. A final
 * carriage return submits. Without that mode the prompt is written as-is,
 * then Enter.
 */
export function formatMagicPromptForPty(
  prompt: string,
  bracketedPaste: boolean
): string {
  const normalized = prompt.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!bracketedPaste) return `${normalized}\r`
  const pasted = normalized.replace(/\n/g, '\r')
  return `${BRACKETED_PASTE_START}${pasted}${BRACKETED_PASTE_END}\r`
}

/**
 * Send a prompt that would have gone to the current chat session.
 *
 * Returns `chat` when the caller should keep the normal send path. Returns
 * `pty` after writing the prompt into the session's running terminal. Returns
 * `exited` after toasting, with nothing written.
 */
export function routeCurrentSessionMagicPrompt(
  sessionId: string | null | undefined,
  prompt: string
): MagicPromptRoute {
  if (!sessionId) return 'chat'
  const ui = useUIStore.getState()
  if (ui.sessionPrimarySurface[sessionId] !== 'terminal') return 'chat'

  const terminalId = ui.sessionTerminalIds[sessionId]
  const running =
    !!terminalId && useTerminalStore.getState().isTerminalRunning(terminalId)
  if (!terminalId || !running) {
    toast.error(
      'This terminal session has exited. Start it again before sending a Magic prompt.'
    )
    return 'exited'
  }

  const data = formatMagicPromptForPty(
    prompt,
    terminalAcceptsBracketedPaste(terminalId)
  )
  void invoke('terminal_write', { terminalId, data }).catch(error => {
    toast.error(`Could not send the Magic prompt to the terminal: ${error}`)
  })
  return 'pty'
}
