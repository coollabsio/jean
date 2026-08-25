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
import { useAntigravityCliStatus, useAntigravityCliAuth } from '@/services/antigravity-cli'
import type { CliBackend } from '@/types/preferences'

/**
 * Backend is usable for chat/sends when installed and not known-unauthenticated.
 * While auth is still loading (`authenticated` undefined), treat as usable so the
 * picker/send path doesn't flash empty or false blocks; once auth resolves to
 * false, exclude it from "usable" lists.
 */
export function isBackendUsable(
  installed: boolean | undefined,
  authenticated: boolean | undefined
): boolean {
  if (!installed) return false
  // Auth not resolved yet — keep usable so picker doesn't flash empty
  if (authenticated === undefined) return true
  return authenticated
}

/**
 * Returns backends whose CLIs are currently installed.
 *
 * Use this to filter backend/model selection UI so users can pick any installed
 * backend (including ones that still need login). Auth is checked at send time
 * and shown in backend settings — hiding unauthenticated backends made defaults
 * and model pickers look broken when auth probes false-negative (issue #627/#649).
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
  const antigravity = useAntigravityCliStatus({ enabled })

  const installedBackends = useMemo(() => {
    const backends: CliBackend[] = []
    if (claude.data?.installed) backends.push('claude')
    if (codex.data?.installed) backends.push('codex')
    if (opencode.data?.installed) backends.push('opencode')
    if (cursor.data?.installed) backends.push('cursor')
    if (pi.data?.installed) backends.push('pi')
    if (commandcode.data?.installed) backends.push('commandcode')
    if (grok.data?.installed) backends.push('grok')
    if (kimi.data?.installed) backends.push('kimi')
    if (antigravity.data?.installed) backends.push('antigravity')
    return backends
  }, [
    claude.data?.installed,
    codex.data?.installed,
    opencode.data?.installed,
    cursor.data?.installed,
    pi.data?.installed,
    commandcode.data?.installed,
    grok.data?.installed,
    kimi.data?.installed,
    antigravity.data?.installed,
  ])

  const isLoading =
    claude.isLoading ||
    codex.isLoading ||
    opencode.isLoading ||
    cursor.isLoading ||
    pi.isLoading ||
    commandcode.isLoading ||
    grok.isLoading ||
    kimi.isLoading ||
    antigravity.isLoading

  return {
    installedBackends,
    isLoading,
  }
}

/**
 * Auth status per installed backend. `undefined` means still loading / not probed.
 * Prefer this (plus `isBackendUsable`) when you need login-aware send gates.
 */
export function useBackendAuthStatuses(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true
  const claude = useClaudeCliStatus({ enabled })
  const codex = useCodexCliStatus({ enabled })
  const opencode = useOpencodeCliStatus({ enabled })
  const cursor = useCursorCliStatus({ enabled })
  const pi = usePiCliStatus({ enabled })
  const commandcode = useCommandCodeCliStatus({ enabled })
  const grok = useGrokCliStatus({ enabled })
  const kimi = useKimiCliStatus({ enabled })
  const antigravity = useAntigravityCliStatus({ enabled })

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
  const antigravityAuth = useAntigravityCliAuth({
    enabled: enabled && !!antigravity.data?.installed,
  })

  const authByBackend = useMemo(() => {
    const map: Partial<Record<CliBackend, boolean | undefined>> = {
      claude: claude.data?.installed
        ? claudeAuth.data?.authenticated
        : undefined,
      codex: codex.data?.installed ? codexAuth.data?.authenticated : undefined,
      opencode: opencode.data?.installed
        ? opencodeAuth.data?.authenticated
        : undefined,
      cursor: cursor.data?.installed
        ? cursorAuth.data?.authenticated
        : undefined,
      pi: pi.data?.installed ? piAuth.data?.authenticated : undefined,
      commandcode: commandcode.data?.installed
        ? commandcodeAuth.data?.authenticated
        : undefined,
      grok: grok.data?.installed ? grokAuth.data?.authenticated : undefined,
      kimi: kimi.data?.installed ? kimiAuth.data?.authenticated : undefined,
      antigravity: antigravity.data?.installed
        ? antigravityAuth.data?.authenticated
        : undefined,
    }
    return map
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
    antigravity.data?.installed,
    antigravityAuth.data?.authenticated,
  ])

  const isStatusLoading =
    claude.isLoading ||
    codex.isLoading ||
    opencode.isLoading ||
    cursor.isLoading ||
    pi.isLoading ||
    commandcode.isLoading ||
    grok.isLoading ||
    kimi.isLoading ||
    antigravity.isLoading

  const isAuthLoading =
    (!!claude.data?.installed && claudeAuth.isLoading) ||
    (!!codex.data?.installed && codexAuth.isLoading) ||
    (!!opencode.data?.installed && opencodeAuth.isLoading) ||
    (!!cursor.data?.installed && cursorAuth.isLoading) ||
    (!!pi.data?.installed && piAuth.isLoading) ||
    (!!commandcode.data?.installed && commandcodeAuth.isLoading) ||
    (!!grok.data?.installed && grokAuth.isLoading) ||
    (!!kimi.data?.installed && kimiAuth.isLoading) ||
    (!!antigravity.data?.installed && antigravityAuth.isLoading)

  return {
    authByBackend,
    isLoading: isStatusLoading || isAuthLoading,
  }
}
