import { MUSE_EFFORT_LEVEL_OPTIONS } from '@/components/chat/toolbar/toolbar-options'
import {
  getCatalogModelReasoning,
  type ModelReasoningCapability,
} from '@/services/model-catalog'
import {
  effortLevelOptions,
  type CliBackend,
  type CustomCliProfile,
} from '@/types/preferences'

const BACKEND_EFFORT_FALLBACK = {
  type: 'effort' as const,
  default: 'high',
  levels: [
    { value: 'low', label: 'Low', description: 'Light' },
    { value: 'medium', label: 'Medium', description: 'Moderate' },
    { value: 'high', label: 'High', description: 'Deep' },
    { value: 'xhigh', label: 'Extra high', description: 'Extra deep' },
  ],
}
// Antigravity CLI only accepts --effort low|medium|high; Adaptive omits the flag.
const ANTIGRAVITY_EFFORT_FALLBACK = {
  type: 'effort' as const,
  default: 'adaptive',
  levels: [
    {
      value: 'adaptive',
      label: 'Adaptive/Default',
      description: 'Model default (no forced level)',
    },
    { value: 'low', label: 'Low', description: 'Light' },
    { value: 'medium', label: 'Medium', description: 'Moderate' },
    { value: 'high', label: 'High', description: 'Deep' },
  ],
}
const MUSE_EFFORT_FALLBACK = {
  type: 'effort' as const,
  default: 'high',
  levels: MUSE_EFFORT_LEVEL_OPTIONS,
}

/**
 * Effort levels a Magic Prompt can store for a Claude model the catalog does
 * not describe. The persisted field is an effort string (`magic_prompt_efforts`
 * / `reasoning_effort`), so the picker offers Claude effort values. Thinking
 * levels belong to the separate plan-approval override fields.
 */
const CLAUDE_MAGIC_PROMPT_EFFORT: ModelReasoningCapability = {
  type: 'effort',
  default: 'high',
  levels: effortLevelOptions,
}

/**
 * Reasoning control for one Magic Prompt model.
 *
 * A catalog capability wins, including an explicit `null` that hides the
 * control. Claude models missing from the catalog — custom ids, and aliases
 * a custom CLI profile remaps — fall back to Claude effort levels. The
 * selected profile does not hide the control: without catalog metadata the
 * stored value still has to be an effort string.
 */
export function getMagicPromptModelReasoning(
  catalog: Parameters<typeof getCatalogModelReasoning>[0],
  backend: CliBackend,
  model: string,
  _provider: string | null | undefined,
  _profiles: CustomCliProfile[]
): ModelReasoningCapability | null | undefined {
  const reasoning = getCatalogModelReasoning(catalog, backend, model)
  if (reasoning !== undefined) return reasoning
  if (backend === 'claude') return CLAUDE_MAGIC_PROMPT_EFFORT
  if (backend === 'antigravity') return ANTIGRAVITY_EFFORT_FALLBACK
  if (backend === 'muse') return MUSE_EFFORT_FALLBACK
  return ['opencode', 'pi', 'grok', 'kimi'].includes(backend)
    ? BACKEND_EFFORT_FALLBACK
    : undefined
}
