import {
  ANTIGRAVITY_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  GROK_MODEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_MODEL_OPTIONS,
  KIMI_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  formatCommandCodeModelLabel,
  formatCursorModelLabel,
  formatGrokPromptModelLabel,
  formatOpenCodePromptModelLabel,
  formatOpencodeModelLabel,
  formatPiModelLabel,
  formatModelIdTailLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import { getBackendLabel } from '@/components/ui/backend-label'
import type { Backend, ChatMessage } from '@/types/chat'
import {
  codexDefaultModelOptions,
  getClaudeFastInfo,
  isCodexModel,
  isCommandCodeModel,
  isCursorModel,
  isGrokModel,
  isOpenCodeModel,
  isPiModel,
  isKimiModel,
  isAntigravityCliModel,
} from '@/types/preferences'

const ALL_MODEL_OPTIONS = [
  ...MODEL_OPTIONS,
  ...CODEX_MODEL_OPTIONS,
  ...codexDefaultModelOptions,
  ...OPENCODE_MODEL_OPTIONS,
  ...CURSOR_MODEL_OPTIONS,
  ...PI_MODEL_OPTIONS,
  ...GROK_MODEL_OPTIONS,
  ...KIMI_MODEL_OPTIONS,
  ...ANTIGRAVITY_MODEL_OPTIONS,
]

export function getMessageModelLabel(model: string): string {
  const directLabel = ALL_MODEL_OPTIONS.find(
    option => option.value === model
  )?.label
  if (directLabel) return directLabel

  const claudeFastInfo = getClaudeFastInfo(model)
  if (claudeFastInfo.isFast) {
    const baseLabel = ALL_MODEL_OPTIONS.find(
      option => option.value === claudeFastInfo.baseModel
    )?.label
    if (baseLabel) return `${baseLabel} Fast`
  }

  if (model.startsWith('cursor/')) return formatCursorModelLabel(model)
  if (model.startsWith('pi/')) return formatPiModelLabel(model)
  if (model.startsWith('commandcode/'))
    return formatCommandCodeModelLabel(model)
  if (model.startsWith('kimi/'))
    return formatModelIdTailLabel(model.slice('kimi/'.length)).replace(
      /\bFOR\b/g,
      'for'
    )
  if (model.startsWith('antigravity/'))
    return formatModelIdTailLabel(model.slice('antigravity/'.length))
  return model.includes('/') ? formatOpencodeModelLabel(model) : model
}

function isClaudeMessageModel(model: string): boolean {
  if (MODEL_OPTIONS.some(option => option.value === model)) return true
  if (model.startsWith('claude-')) return true

  const claudeFastInfo = getClaudeFastInfo(model)
  return (
    claudeFastInfo.isFast &&
    MODEL_OPTIONS.some(option => option.value === claudeFastInfo.baseModel)
  )
}

export function getMessagePromptModelLabel(model: string): string {
  if (isCodexModel(model)) return `Codex · ${getMessageModelLabel(model)}`
  if (isCommandCodeModel(model)) return getMessageModelLabel(model)
  if (isOpenCodeModel(model)) {
    return `OpenCode · ${formatOpenCodePromptModelLabel(model)}`
  }
  if (isCursorModel(model)) return `Cursor · ${getMessageModelLabel(model)}`
  if (isPiModel(model)) return `PI · ${getMessageModelLabel(model)}`
  if (isGrokModel(model)) return `Grok · ${formatGrokPromptModelLabel(model)}`
  if (isKimiModel(model)) return `Kimi Code · ${getMessageModelLabel(model)}`
  if (isAntigravityCliModel(model))
    return `Antigravity CLI · ${getMessageModelLabel(model)}`
  if (isClaudeMessageModel(model))
    return `Claude · ${getMessageModelLabel(model)}`
  return getMessageModelLabel(model)
}

/**
 * Infer the chat backend/provider from a user-message model id.
 * Mirrors Rust `infer_backend_from_model` ordering used on send.
 */
export function inferBackendFromModel(
  model: string | undefined | null
): Backend | null {
  if (!model) return null
  if (isCursorModel(model)) return 'cursor'
  if (isPiModel(model)) return 'pi'
  if (isOpenCodeModel(model)) return 'opencode'
  if (isCommandCodeModel(model)) return 'commandcode'
  if (isGrokModel(model)) return 'grok'
  if (isKimiModel(model)) return 'kimi'
  if (isAntigravityCliModel(model)) return 'antigravity'
  if (isCodexModel(model)) return 'codex'
  if (isClaudeMessageModel(model)) return 'claude'
  // Legacy short aliases + bare Claude ids
  if (
    model === 'opus' ||
    model === 'sonnet' ||
    model === 'haiku' ||
    model.startsWith('claude-')
  ) {
    return 'claude'
  }
  // OpenCode-style `provider/model` ids without the opencode/ prefix
  if (model.includes('/')) return 'opencode'
  return 'claude'
}

export function getMessageProviderLabel(backend: Backend): string {
  return getBackendLabel(backend)
}

export interface ProviderChange {
  from: Backend
  to: Backend
  fromLabel: string
  toLabel: string
}

/**
 * When a user prompt uses a different backend than the previous user prompt,
 * return the switch details so the message list can render a separator.
 */
export function getProviderChangeBeforeMessage(
  messages: ChatMessage[],
  index: number
): ProviderChange | null {
  const current = messages[index]
  if (!current || current.role !== 'user') return null

  const to = current.backend ?? inferBackendFromModel(current.model)
  if (!to) return null

  for (let i = index - 1; i >= 0; i--) {
    const previous = messages[i]
    if (previous?.role !== 'user' || (!previous.backend && !previous.model))
      continue

    const from = previous.backend ?? inferBackendFromModel(previous.model)
    if (!from || from === to) return null

    return {
      from,
      to,
      fromLabel: getMessageProviderLabel(from),
      toLabel: getMessageProviderLabel(to),
    }
  }

  return null
}
