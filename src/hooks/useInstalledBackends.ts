import { useMemo } from 'react'
import { useClaudeCliStatus } from '@/services/claude-cli'
import { useCodexCliStatus } from '@/services/codex-cli'
import { useOpencodeCliStatus } from '@/services/opencode-cli'
import { useCursorCliStatus } from '@/services/cursor-cli'
import { usePiCliStatus } from '@/services/pi-cli'
import { useCommandCodeCliStatus } from '@/services/commandcode-cli'
import { useGrokCliStatus } from '@/services/grok-cli'
import { useKimiCliStatus } from '@/services/kimi-cli'
import type { CliBackend } from '@/types/preferences'

/**
 * Returns only the backends whose CLIs are currently installed.
 * Use this to filter backend selection UI so users can't pick uninstalled ones.
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
  ])

  return {
    installedBackends,
    isLoading:
      claude.isLoading ||
      codex.isLoading ||
      opencode.isLoading ||
      cursor.isLoading ||
      pi.isLoading ||
      commandcode.isLoading ||
      grok.isLoading ||
      kimi.isLoading,
  }
}
