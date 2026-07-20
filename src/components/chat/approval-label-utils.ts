import { getMessageModelLabel } from '@/components/chat/message-settings-labels'

interface ResolveApprovalLabelOptions {
  forceModeOverride?: boolean
}

const BACKEND_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  commandcode: 'CommandCode',
  pi: 'PI',
  grok: 'Grok',
  kimi: 'Kimi Code',
}

function formatBackendLabel(backend: string): string {
  return (
    BACKEND_LABELS[backend] ??
    backend.charAt(0).toUpperCase() + backend.slice(1)
  )
}

/**
 * Resolves a human-readable label for the backend + model that will be used
 * when approving a plan in build or yolo mode.
 */
export function resolveApprovalLabel(
  mode: 'build' | 'yolo',
  preferences:
    | {
        build_model?: string | null
        build_backend?: string | null
        yolo_model?: string | null
        yolo_backend?: string | null
        selected_model?: string | null
        selected_codex_model?: string | null
        selected_opencode_model?: string | null
        selected_cursor_model?: string | null
        selected_commandcode_model?: string | null
        selected_pi_model?: string | null
        selected_grok_model?: string | null
        selected_kimi_model?: string | null
        default_backend?: string | null
      }
    | undefined,
  sessionBackend?: string | null,
  options: ResolveApprovalLabelOptions = {}
): string | null {
  if (!preferences) return null
  const modeBackend =
    mode === 'yolo' ? preferences.yolo_backend : preferences.build_backend
  const overridesApply =
    options.forceModeOverride ||
    !modeBackend ||
    !sessionBackend ||
    modeBackend === sessionBackend
  const model = overridesApply
    ? mode === 'yolo'
      ? preferences.yolo_model
      : preferences.build_model
    : null
  const backend = overridesApply ? modeBackend : null
  const resolvedBackend =
    backend ?? sessionBackend ?? preferences.default_backend ?? 'claude'
  const backendDefaultModel =
    resolvedBackend === 'codex'
      ? (preferences.selected_codex_model ?? 'gpt-5.6-sol')
      : resolvedBackend === 'opencode'
        ? (preferences.selected_opencode_model ?? 'opencode/gpt-5.6-sol')
        : resolvedBackend === 'cursor'
          ? (preferences.selected_cursor_model ?? 'cursor/auto')
          : resolvedBackend === 'commandcode'
            ? (preferences.selected_commandcode_model ?? 'commandcode/default')
            : resolvedBackend === 'pi'
              ? (preferences.selected_pi_model ?? 'pi/sonnet')
              : resolvedBackend === 'grok'
                ? (preferences.selected_grok_model ??
                  'grok/grok-4.5')
                : resolvedBackend === 'kimi'
                  ? (preferences.selected_kimi_model ?? 'kimi/default')
                  : (preferences.selected_model ?? null)
  const resolvedModel = model ?? backendDefaultModel
  if (!resolvedModel && !resolvedBackend) return null
  const modelLabel = resolvedModel ? getMessageModelLabel(resolvedModel) : null
  const parts: string[] = []
  if (resolvedBackend) parts.push(formatBackendLabel(resolvedBackend))
  if (modelLabel) parts.push(modelLabel)
  return parts.length > 0 ? parts.join(' · ') : null
}
