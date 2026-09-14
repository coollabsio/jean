/**
 * Resolve installed CLI binary paths for terminal launches.
 *
 * When the user uses a Jean-managed install (default for most backends), the
 * binary lives under app data and is not on PATH. Native terminal sessions
 * must launch the absolute resolved path from `check_*_cli_installed`.
 */

import { invoke } from '@/lib/transport'
import { hasBackendTransport } from '@/lib/environment'
import type { Backend } from '@/types/chat'

const BARE_BACKEND_COMMANDS: Partial<Record<Backend, string>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor-agent',
  pi: 'pi',
  commandcode: 'commandcode',
  grok: 'grok',
  kimi: 'kimi',
  antigravity: 'agy',
}

const STATUS_COMMANDS: Partial<Record<Backend, string>> = {
  claude: 'check_claude_cli_installed',
  codex: 'check_codex_cli_installed',
  opencode: 'check_opencode_cli_installed',
  cursor: 'check_cursor_cli_installed',
  pi: 'check_pi_cli_installed',
  commandcode: 'check_commandcode_cli_installed',
  grok: 'check_grok_cli_installed',
  kimi: 'check_kimi_cli_installed',
  antigravity: 'check_antigravity_cli_installed',
}

/** True when `command` looks like a bare tool name (not an absolute/relative path). */
export function isBareCliCommand(command: string | null | undefined): boolean {
  if (!command) return true
  const trimmed = command.trim()
  if (!trimmed) return true
  // Absolute paths, Windows paths, or relative paths with separators.
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    return false
  }
  return true
}

/**
 * Prefer a Jean-resolved absolute path when the stored/fallback command is bare
 * (e.g. `grok` not on PATH because the user uses the Jean-managed install).
 */
export function preferResolvedCliCommand(
  command: string | null | undefined,
  fallbackBare: string,
  resolvedPath?: string | null
): string {
  const resolved = resolvedPath?.trim()
  if (resolved && isBareCliCommand(command)) {
    return resolved
  }
  const existing = command?.trim()
  if (existing) return existing
  if (resolved) return resolved
  return fallbackBare
}

export function bareCommandForBackend(backend: Backend | undefined): string {
  if (!backend) return ''
  return BARE_BACKEND_COMMANDS[backend] ?? backend
}

/**
 * Ask the backend for the installed CLI path (Jean-managed or PATH), matching
 * the user's `*_cli_source` preference.
 */
export async function resolveBackendCliPath(
  backend: Backend | undefined | null
): Promise<string | null> {
  if (!backend || !hasBackendTransport()) return null
  const command = STATUS_COMMANDS[backend]
  if (!command) return null
  try {
    const status = await invoke<{
      installed?: boolean
      path?: string | null
    }>(command)
    if (status?.installed && status.path?.trim()) {
      return status.path.trim()
    }
  } catch {
    // Fall through — caller keeps bare name.
  }
  return null
}
