import {
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
  if (isClaudeMessageModel(model))
    return `Claude · ${getMessageModelLabel(model)}`
  return getMessageModelLabel(model)
}
