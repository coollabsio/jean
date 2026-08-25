/**
 * CLI authentication helpers for chat UX (issue #387).
 *
 * Claude (and other backends) emit messages like "Not logged in · Please run /login"
 * that do not work inside Jean's headless chat. Jean owns interactive login via
 * CliLoginModal — these helpers detect auth failures and open that flow instead.
 */

import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import type { CliBackend } from '@/types/preferences'
import { getBackendPlainLabel } from '@/components/ui/backend-label'

/** True when a backend error indicates the user needs to re-authenticate. */
export function isCliAuthError(error: string): boolean {
  const lower = error.toLowerCase()
  if (
    lower.includes('not logged in') ||
    lower.includes('please run /login') ||
    lower.includes('not authenticated') ||
    lower.includes('authentication required') ||
    lower.includes('auth required') ||
    lower.includes('login required') ||
    lower.includes('please log in') ||
    lower.includes('please login') ||
    lower.includes('unauthorized') ||
    lower.includes('token expired') ||
    lower.includes('session expired') ||
    lower.includes('to authenticate') ||
    lower.includes('to log in again') ||
    lower.includes('to login again') ||
    lower.includes('run `claude`') ||
    lower.includes('run `codex`') ||
    lower.includes('run `opencode`') ||
    lower.includes('run `agy`') ||
    lower.includes('launch the cli without arguments to sign in')
  ) {
    return true
  }
  // Claude headless: "/login isn't available in this environment"
  if (
    lower.includes("isn't available in this environment") &&
    lower.includes('login')
  ) {
    return true
  }
  return false
}

/** Jean-facing message — never recommend interactive /login inside chat. */
export function rewriteCliAuthErrorMessage(
  _error: string,
  backend: CliBackend | string
): string {
  const label = getBackendPlainLabel(backend as CliBackend) || String(backend)
  return (
    `${label} is not authenticated. ` +
    `Use Settings → ${label} → Login (interactive /login is not available in Jean chat).`
  )
}

/** True when Codex reports a missing Linux sandbox / bubblewrap dependency. */
export function isCodexBubblewrapError(error: string): boolean {
  const lower = error.toLowerCase()
  return (
    lower.includes('bubblewrap') ||
    lower.includes('no system bwrap') ||
    (lower.includes('bwrap') &&
      (lower.includes('not found') ||
        lower.includes('unavailable') ||
        lower.includes('could not find')))
  )
}

/** User-facing guidance when Codex sandbox cannot find bubblewrap. */
export function rewriteCodexBubblewrapErrorMessage(error: string): string {
  if (/apt install bubblewrap/i.test(error)) {
    return error
  }
  return (
    'Codex sandbox requires bubblewrap. Install it with: sudo apt install bubblewrap ' +
    '(or your distro equivalent: dnf/pacman). Jean Settings → Codex also shows this warning ' +
    'when bwrap is missing. See https://developers.openai.com/codex/concepts/sandboxing#prerequisites'
  )
}

/** Login CLI args for the given backend. */
export function loginArgsForBackend(
  backend: CliBackend,
  supportsAuthCommand = true
): string[] {
  switch (backend) {
    case 'claude':
      return supportsAuthCommand ? ['auth', 'login'] : ['login']
    case 'codex':
      // Device-code auth works in Jean's embedded terminal and on headless
      // servers. Browser callback (`codex login`) often fails without a local
      // display / callback listener (Codex itself recommends --device-auth).
      return ['login', '--device-auth']
    case 'opencode':
      return ['auth', 'login']
    case 'cursor':
      return ['login']
    case 'pi':
      return []
    case 'commandcode':
      return ['login']
    case 'grok':
      return ['login']
    case 'kimi':
      return ['login']
    case 'antigravity':
      // Antigravity authentication is selected from its interactive start screen.
      return []
    default:
      return ['login']
  }
}

const STATUS_COMMANDS: Partial<
  Record<CliBackend, { command: string; pathField?: string }>
> = {
  claude: { command: 'check_claude_cli_installed' },
  codex: { command: 'check_codex_cli_installed' },
  opencode: { command: 'check_opencode_cli_installed' },
  cursor: { command: 'check_cursor_cli_installed' },
  pi: { command: 'check_pi_cli_installed' },
  commandcode: { command: 'check_commandcode_cli_installed' },
  grok: { command: 'check_grok_cli_installed' },
  kimi: { command: 'check_kimi_cli_installed' },
  antigravity: { command: 'check_antigravity_cli_installed' },
}

/**
 * Resolve the binary path for a backend and open the CLI login modal.
 * Returns false if the backend is not installed / path is unknown.
 */
export async function openBackendLoginModal(
  backend: CliBackend
): Promise<boolean> {
  const statusCmd = STATUS_COMMANDS[backend]
  if (!statusCmd) {
    toast.error(`Login is not supported for ${backend}`)
    return false
  }

  try {
    const status = await invoke<{
      installed?: boolean
      path?: string | null
      supports_auth_command?: boolean
    }>(statusCmd.command)

    const path = status?.path
    if (!path) {
      toast.error(
        `${getBackendPlainLabel(backend)} is not installed. Install it in Settings first.`
      )
      return false
    }

    const args = loginArgsForBackend(
      backend,
      status.supports_auth_command ?? true
    )
    const loginType =
      backend === 'claude' ||
      backend === 'codex' ||
      backend === 'opencode' ||
      backend === 'cursor' ||
      backend === 'pi' ||
      backend === 'commandcode' ||
      backend === 'grok' ||
      backend === 'kimi' ||
      backend === 'antigravity'
        ? backend
        : null
    if (!loginType) {
      toast.error(`Login is not supported for ${backend}`)
      return false
    }
    useUIStore.getState().openCliLoginModal(loginType, path, args, 'login')
    return true
  } catch (err) {
    toast.error(`Failed to start login: ${err}`)
    return false
  }
}

/**
 * Show a toast for an auth error with a Login action that opens CliLoginModal.
 * Also returns the rewritten user-facing error string for inline display.
 */
export function handleCliAuthError(
  error: string,
  backend: CliBackend | string | null | undefined
): string {
  const resolvedBackend = (backend ?? 'claude') as CliBackend
  const rewritten = rewriteCliAuthErrorMessage(error, resolvedBackend)
  const label = getBackendPlainLabel(resolvedBackend) || String(resolvedBackend)

  toast.error(rewritten, {
    id: `cli-auth-${resolvedBackend}`,
    duration: 15_000,
    action: {
      label: 'Login',
      onClick: () => {
        void openBackendLoginModal(resolvedBackend)
      },
    },
    description: `Or open Settings → ${label} → Login`,
  })

  return rewritten
}

/** True when the user message is only the interactive /login slash command. */
export function isLoginSlashCommand(message: string): boolean {
  return /^\/login\s*$/i.test(message.trim())
}
