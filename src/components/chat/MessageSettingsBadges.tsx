import { memo } from 'react'
import {
  EFFORT_LEVEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { getMessagePromptModelLabel } from '@/components/chat/message-settings-labels'
import {
  isCodexModel,
  isGrokModel,
  isKimiModel,
  isPiModel,
} from '@/types/preferences'
import type { EffortLevel, ExecutionMode, ThinkingLevel } from '@/types/chat'

interface MessageSettingsBadgesProps {
  model: string | undefined
  executionMode: ExecutionMode | undefined
  thinkingLevel: ThinkingLevel | undefined
  effortLevel: EffortLevel | undefined
  isCursor: boolean
}

export const MessageSettingsBadges = memo(function MessageSettingsBadges({
  model,
  executionMode,
  thinkingLevel,
  effortLevel,
  isCursor,
}: MessageSettingsBadgesProps) {
  if (!model) return null

  const modelLabel = getMessagePromptModelLabel(model)
  const isCodex =
    !model.startsWith('pi/') && (isCodexModel(model) || model.includes('codex'))
  // Effort-based backends should never fall back to Claude thinking labels
  // (e.g. "Think") when effort is missing from a message/run.
  const usesEffortOnly =
    isCodex ||
    isGrokModel(model) ||
    isKimiModel(model) ||
    isPiModel(model) ||
    model.startsWith('pi/')
  const executionModeLabel = executionMode
    ? executionMode.charAt(0).toUpperCase() + executionMode.slice(1)
    : null

  const effortOptions = model.startsWith('pi/')
    ? PI_EFFORT_LEVEL_OPTIONS
    : EFFORT_LEVEL_OPTIONS

  const effortLabel = effortLevel
    ? (effortOptions.find(o => o.value === effortLevel)?.label ?? effortLevel)
    : null

  const thinkingLabel =
    !usesEffortOnly && thinkingLevel && thinkingLevel !== 'off'
      ? (THINKING_LEVEL_OPTIONS.find(o => o.value === thinkingLevel)?.label ??
        thinkingLevel)
      : null

  return (
    <div className="flex items-center text-[10px] text-muted-foreground/50">
      <span>{modelLabel}</span>
      {executionModeLabel && <span>&nbsp;· {executionModeLabel}</span>}
      {!isCursor && effortLabel && <span>&nbsp;· {effortLabel}</span>}
      {!isCursor && !effortLabel && thinkingLabel && (
        <span>&nbsp;· {thinkingLabel}</span>
      )}
    </div>
  )
})
