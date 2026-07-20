import {
  codexModelOptions,
  modelOptions,
  type ClaudeModel,
} from '@/types/preferences'
import type { EffortLevel, ThinkingLevel } from '@/types/chat'

export const MODEL_OPTIONS: { value: ClaudeModel; label: string }[] =
  modelOptions.map(option => ({
    value: option.value,
    label: option.label.replace(/^Claude\s+/, ''),
  }))

export const CODEX_MODEL_OPTIONS = codexModelOptions as {
  value: string
  label: string
}[]

export const OPENCODE_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'opencode/gpt-5.6-sol', label: 'GPT 5.6 Sol (OpenCode)' },
]

export const COMMANDCODE_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'commandcode/default', label: 'CLI default (no --model)' },
  { value: 'commandcode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'commandcode/claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'commandcode/claude-opus-4-7', label: 'Claude Opus 4.7' },
  { value: 'commandcode/claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'commandcode/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { value: 'commandcode/gpt-5.5', label: 'GPT-5.5' },
  { value: 'commandcode/gpt-5.4', label: 'GPT-5.4' },
  { value: 'commandcode/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'commandcode/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'commandcode/google/gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  {
    value: 'commandcode/google/gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
  },
  { value: 'commandcode/moonshotai/Kimi-K2.6', label: 'Kimi K2.6' },
  { value: 'commandcode/moonshotai/Kimi-K2.5', label: 'Kimi K2.5' },
  { value: 'commandcode/zai-org/GLM-5.1', label: 'GLM-5.1' },
  { value: 'commandcode/zai-org/GLM-5', label: 'GLM-5' },
  { value: 'commandcode/MiniMaxAI/MiniMax-M3', label: 'MiniMax M3' },
  { value: 'commandcode/MiniMaxAI/MiniMax-M2.7', label: 'MiniMax M2.7' },
  { value: 'commandcode/MiniMaxAI/MiniMax-M2.5', label: 'MiniMax M2.5' },
  {
    value: 'commandcode/deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
  },
  {
    value: 'commandcode/deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
  },
  {
    value: 'commandcode/Qwen/Qwen3.6-Max-Preview',
    label: 'Qwen 3.6 Max Preview',
  },
  { value: 'commandcode/Qwen/Qwen3.6-Plus', label: 'Qwen 3.6 Plus' },
  { value: 'commandcode/Qwen/Qwen3.7-Max', label: 'Qwen 3.7 Max' },
  {
    value: 'commandcode/stepfun/Step-3.5-Flash',
    label: 'Step 3.5 Flash',
  },
  {
    value: 'commandcode/xiaomi/mimo-v2.5-pro',
    label: 'MiMo V2.5 Pro',
  },
  { value: 'commandcode/xiaomi/mimo-v2.5', label: 'MiMo V2.5' },
]

export const CURSOR_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'cursor/composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { value: 'cursor/composer-2.5', label: 'Composer 2.5' },
  { value: 'cursor/composer-2-fast', label: 'Composer 2 Fast' },
  { value: 'cursor/composer-2', label: 'Composer 2' },
  { value: 'cursor/gpt-5.5-high-fast', label: 'GPT-5.5 High Fast' },
  {
    value: 'cursor/claude-opus-4-7-thinking-high',
    label: 'Opus 4.7 1M High Thinking',
  },
  { value: 'cursor/auto', label: 'Auto' },
  { value: 'cursor/gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  { value: 'cursor/grok-4.3', label: 'Grok 4.3 1M' },
]

export const PI_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'pi/sonnet', label: 'Sonnet (PI)' },
  { value: 'pi/sonnet:high', label: 'Sonnet High (PI)' },
  { value: 'pi/opus', label: 'Opus (PI)' },
  { value: 'pi/haiku', label: 'Haiku (PI)' },
]

export const GROK_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'grok/grok-4.5', label: 'Grok 4.5' },
]

export const KIMI_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'kimi/default', label: 'Configured default' },
]

export const KIMI_EFFORT_LEVEL_OPTIONS: {
  value: EffortLevel
  label: string
  description: string
}[] = [
  { value: 'off', label: 'Thinking Off', description: 'Disable thinking' },
  { value: 'high', label: 'Thinking On', description: 'Enable thinking' },
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
  { value: 'xhigh', label: 'xHigh', description: 'Extra high' },
  { value: 'max', label: 'Max', description: 'No limits' },
  {
    value: 'ultracode',
    label: 'Ultracode',
    description: 'xHigh + workflows',
  },
]

export const CODEX_EFFORT_LEVEL_OPTIONS = EFFORT_LEVEL_OPTIONS.filter(
  option => option.value !== 'max' && option.value !== 'ultracode'
)

export const PI_EFFORT_LEVEL_OPTIONS: {
  value: EffortLevel
  label: string
  description: string
}[] = [
  { value: 'off', label: 'Off', description: 'Disabled' },
  { value: 'minimal', label: 'Minimal', description: 'Minimal' },
  { value: 'low', label: 'Low', description: 'Low' },
  { value: 'medium', label: 'Medium', description: 'Moderate' },
  { value: 'high', label: 'High', description: 'High' },
  { value: 'xhigh', label: 'xHigh', description: 'Extra high' },
]

// Grok supports low/medium/high/xhigh/max natively. ultracode is a Jean
// main-loop concept (xHigh + workflows), not a Grok CLI effort level.
export const GROK_EFFORT_LEVEL_OPTIONS = EFFORT_LEVEL_OPTIONS.filter(
  option => option.value !== 'ultracode'
)
