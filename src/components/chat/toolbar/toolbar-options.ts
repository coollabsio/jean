import {
  codexModelOptions,
  type ClaudeModel,
  type CliBackend,
  type CustomCliProfile,
} from '@/types/preferences'
import type { EffortLevel, ThinkingLevel } from '@/types/chat'

export interface ModelOption {
  value: string
  label: string
  backend: CliBackend
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: 'opus', label: 'Opus 4.6', backend: 'claude' },
  { value: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)', backend: 'claude' },
  { value: 'opus-fast', label: 'Opus 4.6 Fast', backend: 'claude' },
  {
    value: 'claude-opus-4-6[1m]-fast',
    label: 'Opus 4.6 (1M) Fast',
    backend: 'claude',
  },
  { value: 'opus-4.5', label: 'Opus 4.5', backend: 'claude' },
  { value: 'sonnet', label: 'Sonnet 4.6', backend: 'claude' },
  {
    value: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet 4.6 (1M)',
    backend: 'claude',
  },
  { value: 'sonnet-4.5', label: 'Sonnet 4.5', backend: 'claude' },
  { value: 'haiku', label: 'Haiku', backend: 'claude' },
]

export const CODEX_MODEL_OPTIONS: ModelOption[] = codexModelOptions.map(option => ({
  ...option,
  backend: 'codex',
}))

export const OPENCODE_MODEL_OPTIONS: ModelOption[] = [
  {
    value: 'opencode/gpt-5.3-codex',
    label: 'GPT-5.3 Codex (OpenCode)',
    backend: 'opencode',
  },
]

export const ALL_MODEL_OPTIONS: ModelOption[] = [
  ...MODEL_OPTIONS,
  ...CODEX_MODEL_OPTIONS,
  ...OPENCODE_MODEL_OPTIONS,
]

export function getClaudeModelOptions(
  selectedProvider: string | null,
  customCliProfiles: CustomCliProfile[]
): ModelOption[] {
  if (!selectedProvider || selectedProvider === '__anthropic__') {
    return MODEL_OPTIONS
  }

  const profile = customCliProfiles.find(p => p.name === selectedProvider)
  let opusModel: string | undefined
  let sonnetModel: string | undefined
  let haikuModel: string | undefined
  if (profile?.settings_json) {
    try {
      const settings = JSON.parse(profile.settings_json)
      const env = settings?.env
      if (env) {
        opusModel = env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL
        sonnetModel =
          env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL
        haikuModel = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL
      }
    } catch {
      // ignore parse errors
    }
  }

  const suffix = (model?: string) => (model ? ` (${model})` : '')
  return [
    {
      value: 'opus' as ClaudeModel,
      label: `Opus${suffix(opusModel)}`,
      backend: 'claude',
    },
    {
      value: 'sonnet' as ClaudeModel,
      label: `Sonnet${suffix(sonnetModel)}`,
      backend: 'claude',
    },
    {
      value: 'haiku' as ClaudeModel,
      label: `Haiku${suffix(haikuModel)}`,
      backend: 'claude',
    },
  ]
}

export function buildUnifiedModelOptions({
  installedBackends,
  selectedProvider,
  customCliProfiles,
  opencodeModelOptions,
}: {
  installedBackends: CliBackend[]
  selectedProvider: string | null
  customCliProfiles: CustomCliProfile[]
  opencodeModelOptions?: ModelOption[]
}): ModelOption[] {
  const claudeOptions = getClaudeModelOptions(selectedProvider, customCliProfiles)
  const perBackend: Record<CliBackend, ModelOption[]> = {
    claude: claudeOptions,
    codex: CODEX_MODEL_OPTIONS,
    opencode: opencodeModelOptions ?? OPENCODE_MODEL_OPTIONS,
  }

  return installedBackends.flatMap(backend => perBackend[backend] ?? [])
}

export function getModelOptionLabel(
  value: string,
  options: ModelOption[] = ALL_MODEL_OPTIONS
): string {
  return options.find(option => option.value === value)?.label ?? value
}

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
