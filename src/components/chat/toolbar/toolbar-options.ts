import { codexModelOptions, type ClaudeModel } from '@/types/preferences'
import type { EffortLevel, ThinkingLevel } from '@/types/chat'

export const MODEL_OPTIONS: { value: ClaudeModel; label: string }[] = [
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
  { value: 'opus-fast', label: 'Opus 4.6 Fast' },
  { value: 'claude-opus-4-6[1m]-fast', label: 'Opus 4.6 (1M) Fast' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)' },
  { value: 'haiku', label: 'Haiku' },
]

export const CODEX_MODEL_OPTIONS = codexModelOptions as {
  value: string
  label: string
}[]

export const OPENCODE_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'opencode/gpt-5.3-codex', label: 'GPT-5.3 Codex (OpenCode)' },
]

export const THINKING_LEVEL_OPTIONS: {
  value: ThinkingLevel
  label: string
  tokens: string
}[] = [
  { value: 'off', label: 'Off', tokens: 'Disabled' },
  { value: 'think', label: 'Think', tokens: '4K' },
  { value: 'megathink', label: 'Megathink', tokens: '10K' },
  { value: 'ultrathink', label: 'Ultrathink', tokens: '32K' },
]

export const EFFORT_LEVEL_OPTIONS: {
  value: EffortLevel
  label: string
  description: string
}[] = [
  { value: 'low', label: 'Low', description: 'Minimal' },
  { value: 'medium', label: 'Medium', description: 'Moderate' },
  { value: 'high', label: 'High', description: 'Deep' },
  { value: 'max', label: 'Max', description: 'No limits' },
]
