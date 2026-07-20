import type {
  Backend,
  RunStatus,
  Session,
  SessionDebugInfo,
  UsageData,
} from '@/types/chat'
import type { AppPreferences } from '@/types/preferences'
import type { Project } from '@/types/projects'
import { getSessionProviderDisplayName } from '@/components/chat/toolbar/toolbar-utils'
import { getModelImpliedBackend } from '@/lib/model-utils'

export interface ResolvedSessionDebugDetails {
  selectedBackend: Backend
  selectedModel: string
  providerDisplay: string
}

export function resolveSessionDebugDetails(params: {
  session?: Session | null
  selectedBackend?: Backend
  selectedModel?: string
  selectedProvider?: string | null
  project?: Project | null
  preferences?: AppPreferences
  installedBackends?: Backend[]
}): ResolvedSessionDebugDetails {
  const {
    session,
    selectedBackend,
    selectedModel,
    selectedProvider,
    project,
    preferences,
    installedBackends = [],
  } = params

  const projectDefaultProvider = project?.default_provider ?? null
  const globalDefaultProvider = preferences?.default_provider ?? null
  const defaultProvider = projectDefaultProvider ?? globalDefaultProvider
  const sessionProvider = session?.selected_provider ?? selectedProvider
  const resolvedProvider =
    sessionProvider !== undefined ? sessionProvider : defaultProvider

  const projectDefaultBackend = (project?.default_backend ??
    null) as Backend | null
  const globalDefaultBackend = (preferences?.default_backend ?? 'claude') as
    | Backend
    | undefined
  const resolvedBackend =
    session?.backend ??
    selectedBackend ??
    projectDefaultBackend ??
    globalDefaultBackend ??
    'claude'
  const model = session?.selected_model ?? selectedModel
  const modelImpliedBackend = getModelImpliedBackend(model)
  const clampedBackend =
    installedBackends.length > 0 && !installedBackends.includes(resolvedBackend)
      ? (installedBackends[0] ?? resolvedBackend)
      : resolvedBackend
  const finalBackend = modelImpliedBackend ?? clampedBackend

  const defaultModel =
    finalBackend === 'codex'
      ? (preferences?.selected_codex_model ?? 'gpt-5.6-sol')
      : finalBackend === 'opencode'
        ? (preferences?.selected_opencode_model ?? 'opencode/gpt-5.6-sol')
        : finalBackend === 'cursor'
          ? (preferences?.selected_cursor_model ?? 'cursor/auto')
          : finalBackend === 'pi'
            ? (preferences?.selected_pi_model ?? 'pi/sonnet')
            : finalBackend === 'commandcode'
              ? (preferences?.selected_commandcode_model ??
                'commandcode/default')
              : finalBackend === 'grok'
                ? (preferences?.selected_grok_model ?? 'grok/grok-4.5')
                : finalBackend === 'kimi'
                  ? (preferences?.selected_kimi_model ?? 'kimi/default')
                  : (preferences?.selected_model ?? 'claude-opus-4-8[1m]')

  return {
    selectedBackend: finalBackend,
    selectedModel: model ?? defaultModel,
    providerDisplay: getSessionProviderDisplayName(
      finalBackend,
      resolvedProvider
    ),
  }
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return tokens.toString()
}

export function formatUsage(usage: UsageData | undefined): string {
  if (!usage) return ''
  return `${formatTokens(usage.input_tokens)} in / ${formatTokens(usage.output_tokens)} out`
}

export function getStatusText(status: RunStatus): string {
  switch (status) {
    case 'crashed':
      return 'completed (recovered)'
    case 'resumable':
      return 'resumable'
    default:
      return status
  }
}

export function formatSessionDebugDetails(params: {
  sessionId: string
  selectedModel?: string
  selectedBackend?: Backend
  providerDisplay: string
  debugInfo: SessionDebugInfo
}): string {
  const {
    sessionId,
    selectedModel,
    selectedBackend,
    providerDisplay,
    debugInfo,
  } = params

  const lines = [
    `session: ${sessionId}`,
    `backend: ${selectedBackend ?? 'unknown'}`,
    `model: ${selectedModel ?? 'unknown'} / provider: ${providerDisplay}`,
    `sessions file: ${debugInfo.sessions_file}`,
    `runs dir: ${debugInfo.runs_dir}`,
    `manifest: ${debugInfo.manifest_file || 'none'}`,
    `total usage: ${formatUsage(debugInfo.total_usage)}`,
    '',
    `Run logs (${debugInfo.run_log_files.length}):`,
    ...debugInfo.run_log_files.map(
      file =>
        `  ${getStatusText(file.status)} ${file.usage ? `(${formatUsage(file.usage)})` : ''} ${file.user_message_preview}`
    ),
  ]

  return lines.join('\n')
}
