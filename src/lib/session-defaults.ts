import type { CliBackend } from '@/types/preferences'
import { DEFAULT_MODEL } from '@/store/chat-store'

interface BackendModelPreferences {
  selected_model?: string
  selected_codex_model?: string
  selected_opencode_model?: string
  selected_cursor_model?: string
  selected_pi_model?: string
  selected_commandcode_model?: string
  selected_grok_model?: string
  selected_kimi_model?: string
}

export interface ModelOption {
  value: string
  label: string
  is_default?: boolean
}

export function resolvePiDefaultModel(
  storedModel: string | null | undefined,
  availableModels?: ModelOption[]
): string {
  const stored = storedModel?.trim()
  if (availableModels?.length) {
    if (stored && availableModels.some(model => model.value === stored)) {
      return stored
    }
    return (
      availableModels.find(model => model.is_default)?.value ??
      availableModels[0]?.value ??
      'pi/sonnet'
    )
  }
  return stored || 'pi/sonnet'
}

export function resolveDefaultModelForBackend(
  backend: CliBackend,
  preferences: BackendModelPreferences | null | undefined,
  availableModels?: ModelOption[]
): string {
  if (backend === 'codex') {
    return preferences?.selected_codex_model ?? 'gpt-5.6-sol'
  }
  if (backend === 'opencode') {
    return preferences?.selected_opencode_model ?? 'opencode/gpt-5.6-sol'
  }
  if (backend === 'cursor') {
    return preferences?.selected_cursor_model ?? 'cursor/auto'
  }
  if (backend === 'pi') {
    return resolvePiDefaultModel(
      preferences?.selected_pi_model,
      availableModels
    )
  }
  if (backend === 'commandcode') {
    return preferences?.selected_commandcode_model ?? 'commandcode/default'
  }
  if (backend === 'grok') {
    return preferences?.selected_grok_model ?? 'grok/grok-4.5'
  }
  if (backend === 'kimi') {
    return preferences?.selected_kimi_model ?? 'kimi/default'
  }
  return preferences?.selected_model ?? DEFAULT_MODEL
}
