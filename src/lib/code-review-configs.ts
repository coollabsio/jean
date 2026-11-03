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
