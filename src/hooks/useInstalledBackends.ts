import { useMemo } from 'react'
import { useClaudeCliStatus, useClaudeCliAuth } from '@/services/claude-cli'
import { useCodexCliStatus, useCodexCliAuth } from '@/services/codex-cli'
import {
  useOpencodeCliStatus,
  useOpencodeCliAuth,
} from '@/services/opencode-cli'
import { useCursorCliStatus, useCursorCliAuth } from '@/services/cursor-cli'
import { usePiCliStatus, usePiCliAuth } from '@/services/pi-cli'
import {
  useCommandCodeCliStatus,
  useCommandCodeCliAuth,
} from '@/services/commandcode-cli'
import { useGrokCliStatus, useGrokCliAuth } from '@/services/grok-cli'
import { useKimiCliStatus, useKimiCliAuth } from '@/services/kimi-cli'
import type { CliBackend } from '@/types/preferences'

/**
 * Backend is usable for chat/models when installed and not known-unauthenticated.
 * While auth is still loading (`authenticated` undefined), treat as usable so the
 * picker doesn't flash empty; once auth resolves to false, exclude it.
 */
export function isBackendUsable(
  installed: boolean | undefined,
  authenticated: boolean | undefined
): boolean {
  if (!installed) return false
  // Auth not resolved yet — keep visible; send path waits on isLoading.
  if (authenticated === undefined) return true
  return authenticated
}

/**
 * Returns backends whose CLIs are installed AND authenticated (or still checking).
 * Use this to filter backend/model selection UI so users can't pick backends
 * they aren't logged into (or that aren't installed).
 */
export function useInstalledBackends(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true
  const claude = useClaudeCliStatus({ enabled })
  const codex = useCodexCliStatus({ enabled })
  const opencode = useOpencodeCliStatus({ enabled })
  const cursor = useCursorCliStatus({ enabled })
  const pi = usePiCliStatus({ enabled })
  const commandcode = useCommandCodeCliStatus({ enabled })
  const grok = useGrokCliStatus({ enabled })
  const kimi = useKimiCliStatus({ enabled })

  const claudeAuth = useClaudeCliAuth({
    enabled: enabled && !!claude.data?.installed,
  })
  const codexAuth = useCodexCliAuth({
    enabled: enabled && !!codex.data?.installed,
  })
  const opencodeAuth = useOpencodeCliAuth({
    enabled: enabled && !!opencode.data?.installed,
  })
  const cursorAuth = useCursorCliAuth({
    enabled: enabled && !!cursor.data?.installed,
  })
  const piAuth = usePiCliAuth({
    enabled: enabled && !!pi.data?.installed,
  })
  const commandcodeAuth = useCommandCodeCliAuth({
    enabled: enabled && !!commandcode.data?.installed,
  })
  const grokAuth = useGrokCliAuth({
    enabled: enabled && !!grok.data?.installed,
  })
  const kimiAuth = useKimiCliAuth({
    enabled: enabled && !!kimi.data?.installed,
  })

  const installedBackends = useMemo(() => {
    const backends: CliBackend[] = []
    if (
      isBackendUsable(claude.data?.installed, claudeAuth.data?.authenticated)
    )
      backends.push('claude')
    if (isBackendUsable(codex.data?.installed, codexAuth.data?.authenticated))
      backends.push('codex')
    if (
      isBackendUsable(
        opencode.data?.installed,
        opencodeAuth.data?.authenticated
      )
    )
      backends.push('opencode')
    if (
      isBackendUsable(cursor.data?.installed, cursorAuth.data?.authenticated)
    )
      backends.push('cursor')
    if (isBackendUsable(pi.data?.installed, piAuth.data?.authenticated))
      backends.push('pi')
    if (
      isBackendUsable(
        commandcode.data?.installed,
        commandcodeAuth.data?.authenticated
      )
    )
      backends.push('commandcode')
    if (isBackendUsable(grok.data?.installed, grokAuth.data?.authenticated))
      backends.push('grok')
    if (isBackendUsable(kimi.data?.installed, kimiAuth.data?.authenticated))
      backends.push('kimi')
    return backends
  }, [
    claude.data?.installed,
    claudeAuth.data?.authenticated,
    codex.data?.installed,
    codexAuth.data?.authenticated,
    opencode.data?.installed,
    opencodeAuth.data?.authenticated,
    cursor.data?.installed,
    cursorAuth.data?.authenticated,
    pi.data?.installed,
    piAuth.data?.authenticated,
    commandcode.data?.installed,
    commandcodeAuth.data?.authenticated,
    grok.data?.installed,
    grokAuth.data?.authenticated,
    kimi.data?.installed,
    kimiAuth.data?.authenticated,
  ])

  const isStatusLoading =
    claude.isLoading ||
    codex.isLoading ||
    opencode.isLoading ||
    cursor.isLoading ||
    pi.isLoading ||
    commandcode.isLoading ||
    grok.isLoading ||
    kimi.isLoading

  // Auth queries are only enabled when installed; count their loading too.
  const isAuthLoading =
    (!!claude.data?.installed && claudeAuth.isLoading) ||
    (!!codex.data?.installed && codexAuth.isLoading) ||
    (!!opencode.data?.installed && opencodeAuth.isLoading) ||
    (!!cursor.data?.installed && cursorAuth.isLoading) ||
    (!!pi.data?.installed && piAuth.isLoading) ||
    (!!commandcode.data?.installed && commandcodeAuth.isLoading) ||
    (!!grok.data?.installed && grokAuth.isLoading) ||
    (!!kimi.data?.installed && kimiAuth.isLoading)

  return {
    installedBackends,
    isLoading: isStatusLoading || isAuthLoading,
  }
}
