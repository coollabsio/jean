import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import {
  createSessionViaInvoke,
  launchMagicPromptTerminal,
  type LaunchMagicPromptTerminalParams,
} from '@/lib/magic-prompt-terminal'
import {
  bareCommandForBackend,
  preferResolvedCliCommand,
  resolveBackendCliPath,
} from '@/services/cli-binary'
import {
  resolveMagicPromptSurface,
  type AppPreferences,
  type CliBackend,
  type MagicPromptSurface,
  type MagicPromptSurfaces,
} from '@/types/preferences'

/**
 * Run a magic prompt in a terminal when its surface preference says so.
 *
 * Returns true when the prompt was handled (launched, or failed loudly) and the
 * caller must not fall through to its chat path. A failed launch deliberately
 * still returns true: the user asked for a terminal, and a surprise headless run
 * would spend tokens they did not intend.
 *
 * Hook-free so callers outside the React tree can use it too; `useMagicPromptRunner`
 * is a thin wrapper that supplies the React Query session mutation.
 */
export async function maybeRunMagicPromptInTerminal({
  preferences,
  surfaceKey,
  prompt,
  backend,
  label,
  model,
  worktreeId,
  worktreePath,
  executionMode,
  surfaceOverride,
  createSession = createSessionViaInvoke,
}: {
  preferences: AppPreferences | undefined
  surfaceKey: keyof MagicPromptSurfaces
  prompt: string
  backend: CliBackend
  label: string
  /** Magic-prompt model for this operation; normalized backend-side. */
  model?: string
  worktreeId: string
  worktreePath: string
  executionMode?: string
  surfaceOverride?: MagicPromptSurface
  createSession?: LaunchMagicPromptTerminalParams['createSession']
}): Promise<boolean> {
  const surface =
    surfaceOverride ??
    resolveMagicPromptSurface(
      preferences?.magic_prompt_surfaces,
      surfaceKey,
      preferences?.default_magic_prompt_surface
    )

  if (surface !== 'terminal') return false

  // Jean-managed installs live under app data and are not on PATH, so a bare
  // name would fail to spawn. Resolve the absolute path first.
  const resolvedPath = await resolveBackendCliPath(backend)
  const command = preferResolvedCliCommand(
    null,
    bareCommandForBackend(backend),
    resolvedPath
  )

  try {
    await launchMagicPromptTerminal({
      prompt,
      backend,
      command,
      worktreeId,
      worktreePath,
      label,
      model,
      yolo: executionMode === 'yolo',
      createSession,
    })
  } catch (error) {
    logger.error('Failed to run magic prompt in terminal', {
      surfaceKey,
      backend,
      error,
    })
    toast.error(`Could not start ${label} in a terminal`, {
      description: String(error),
    })
  }
  return true
}
