import { useCallback } from 'react'
import { maybeRunMagicPromptInTerminal } from '@/lib/magic-prompt-surface'
import { useCreateSession } from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import type { CliBackend, MagicPromptSurfaces } from '@/types/preferences'
import type { ExecutionMode } from '@/types/chat'

/**
 * Chooses where a magic prompt runs.
 *
 * Deliberately shaped as a guard rather than a wrapper around both paths: each
 * call site keeps its existing chat logic untouched and gains a few lines at the
 * top. Folding the chat path in here would mean restructuring two large hooks
 * whose session-priming sequences are load-bearing, for no behavioral gain.
 *
 *     if (await tryRunInTerminal({ ... })) return
 *     // ...existing chat path, unchanged
 *
 * The decision itself lives in `maybeRunMagicPromptInTerminal` so callers
 * outside the React tree (background investigation) share one implementation.
 */

export interface TryRunInTerminalParams {
  /** Which per-prompt surface preference governs this operation. */
  surfaceKey: keyof MagicPromptSurfaces
  /** Fully rendered prompt, exactly as the chat path would send it. */
  prompt: string
  /**
   * Which CLI to launch, already resolved by the caller from
   * `magic_prompt_backends`. That field means "which CLI binary" on both
   * surfaces — spawned headless for chat, as a TUI for terminal — so there is
   * no second backend question to ask.
   */
  backend: CliBackend
  /** Terminal tab label, e.g. "Investigate Failure". */
  label: string
  /** Magic-prompt model for this operation; normalized backend-side. */
  model?: string
  worktreeId: string
  worktreePath: string
  /** Execution mode; `yolo` launches with the backend's bypass flags. */
  executionMode?: ExecutionMode
  /** Per-invocation override that wins over the stored preference. */
  surfaceOverride?: 'chat' | 'terminal'
}

export function useMagicPromptRunner() {
  const { data: preferences } = usePreferences()
  const createSession = useCreateSession()

  const tryRunInTerminal = useCallback(
    (params: TryRunInTerminalParams): Promise<boolean> =>
      maybeRunMagicPromptInTerminal({
        ...params,
        preferences,
        // Use the mutation so the session list cache updates immediately.
        createSession: createSession.mutateAsync,
      }),
    [preferences, createSession.mutateAsync]
  )

  return { tryRunInTerminal }
}
