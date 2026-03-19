import { getModelOptionLabel } from './toolbar/toolbar-options'

/**
 * Resolves a human-readable label for the backend + model that will be used
 * when approving a plan in build or yolo mode.
 */
export function resolveApprovalLabel(
  mode: 'build' | 'yolo',
  preferences: {
    build_model?: string | null
    build_backend?: string | null
    yolo_model?: string | null
    yolo_backend?: string | null
    selected_model?: string | null
    selected_codex_model?: string | null
    selected_opencode_model?: string | null
    default_backend?: string | null
  } | undefined,
): string | null {
  if (!preferences) return null
  const model = mode === 'yolo' ? preferences.yolo_model : preferences.build_model
  const backend = mode === 'yolo' ? preferences.yolo_backend : preferences.build_backend
  const resolvedBackend = backend ?? preferences.default_backend ?? 'claude'
  const backendDefaultModel = resolvedBackend === 'codex'
    ? (preferences.selected_codex_model ?? 'gpt-5.4')
    : resolvedBackend === 'opencode'
      ? (preferences.selected_opencode_model ?? 'opencode/gpt-5.3-codex')
      : (preferences.selected_model ?? null)
  const resolvedModel = model ?? backendDefaultModel
  if (!resolvedModel && !resolvedBackend) return null
  const modelLabel = resolvedModel ? getModelOptionLabel(resolvedModel) : null
  const parts: string[] = []
  if (resolvedBackend && resolvedBackend !== 'claude') parts.push(resolvedBackend)
  if (modelLabel) parts.push(modelLabel)
  return parts.length > 0 ? parts.join(' · ') : null
}
