import type {
  MagicCodeReviewConfig,
  MagicPromptExecutionMode,
  MagicPromptModel,
} from '@/types/preferences'
import { DEFAULT_MAGIC_PROMPT_MODES } from '@/types/preferences'

const MAX_CODE_REVIEW_CONFIGS = 5
const DEFAULT_FIX_MODE: MagicPromptExecutionMode =
  DEFAULT_MAGIC_PROMPT_MODES.code_review_fix_mode

export function codeReviewConfigKey(config: MagicCodeReviewConfig): string {
  return `${config.backend}\u0000${config.model}`
}

/** Resolve plan/yolo mode for sending a reviewer's findings to chat. */
export function resolveCodeReviewFixMode(
  config: Pick<MagicCodeReviewConfig, 'fix_mode'> | null | undefined,
  fallback?: MagicPromptExecutionMode | null
): MagicPromptExecutionMode {
  return config?.fix_mode ?? fallback ?? DEFAULT_FIX_MODE
}

export function resolveCodeReviewConfigs({
  configured,
  fallbackBackend,
  fallbackModel,
}: {
  configured: MagicCodeReviewConfig[] | undefined
  fallbackBackend: string
  fallbackModel: MagicPromptModel
}): MagicCodeReviewConfig[] {
  const configs = configured?.length
    ? configured
    : [
        {
          backend: fallbackBackend,
          model: fallbackModel,
          fix_mode: DEFAULT_FIX_MODE,
        },
      ]
  const seen = new Set<string>()

  return configs.filter(config => {
    const key = codeReviewConfigKey(config)
    if (seen.has(key) || seen.size >= MAX_CODE_REVIEW_CONFIGS) return false
    seen.add(key)
    return true
  })
}

/**
 * Start multi-backend code reviews one at a time.
 * Sequential is intentional: callers chain a shared reviewSessionId across
 * configs (see useGitOperations / MagicModal), so parallel starts would race.
 */
export async function startCodeReviewsSequentially<T>(
  configs: T[],
  startReview: (config: T) => Promise<void>
): Promise<void> {
  const errors: unknown[] = []

  // Sequential: each startReview may depend on prior session id / job setup
  for (const config of configs) {
    try {
      await startReview(config)
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length > 0) throw new AggregateError(errors)
}

export function getCodeReviewSessionName(
  config: MagicCodeReviewConfig
): string {
  const backend =
    config.backend === 'commandcode'
      ? 'Command Code'
      : config.backend === 'opencode'
        ? 'OpenCode'
        : config.backend.charAt(0).toUpperCase() + config.backend.slice(1)
  return `Code Review · ${backend} · ${config.model}`
}
