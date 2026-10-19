import {
  KIMI_EFFORT_LEVEL_OPTIONS,
  MUSE_EFFORT_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  getCatalogModelReasoning,
  type ModelCatalog,
  type ModelReasoningCapability,
} from '@/services/model-catalog'
import {
  codexReasoningOptions,
  effortLevelOptions,
  thinkingLevelOptions,
} from '@/types/preferences'

const EFFORT_FALLBACK_BACKENDS = [
  'codex',
  'opencode',
  'pi',
  'grok',
  'kimi',
  'muse',
]

/**
 * Reasoning control for the build/yolo plan-approval overrides.
 *
 * Claude models missing from the catalog (custom or provider-routed models)
 * fall back to thinking levels, matching the chat toolbar; a catalog `null`
 * still hides the control. Effort backends fall back to their effort levels.
 */
export function resolveOverrideReasoning(
  catalog: ModelCatalog | null | undefined,
  backend: string,
  model: string
): ModelReasoningCapability | null {
  const reasoning = getCatalogModelReasoning(
    catalog,
    backend as Parameters<typeof getCatalogModelReasoning>[1],
    model
  )
  if (reasoning) return reasoning
  if (backend === 'claude') {
    if (reasoning === null) return null
    return {
      type: 'thinking',
      default: 'ultrathink',
      levels: thinkingLevelOptions,
    }
  }
  if (!EFFORT_FALLBACK_BACKENDS.includes(backend)) return null
  return {
    type: 'effort',
    default: 'high',
    levels:
      backend === 'codex'
        ? codexReasoningOptions
        : backend === 'kimi'
          ? KIMI_EFFORT_LEVEL_OPTIONS
          : backend === 'muse'
            ? MUSE_EFFORT_LEVEL_OPTIONS
            : effortLevelOptions,
  }
}
