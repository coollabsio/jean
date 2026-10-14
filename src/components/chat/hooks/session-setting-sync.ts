import type {
  Backend,
  EffortLevel,
  ExecutionMode,
  PermissionMode,
  Session,
  ThinkingLevel,
} from '@/types/chat'

export type SessionSettingKey =
  | 'backend'
  | 'model'
  | 'thinkingLevel'
  | 'effortLevel'
  | 'executionMode'
  | 'permissionMode'
  | 'provider'
  | 'waitingForInput'

/** Sentinels / empty mean "use backend default" (Anthropic / OpenAI). */
export function normalizeProviderSettingValue(
  value: string | null | undefined
): string | undefined {
  if (
    value == null ||
    value === '' ||
    value === '__anthropic__' ||
    value === '__default__' ||
    value === 'default'
  ) {
    return undefined
  }
  return value
}

export function applySessionSettingToSession(
  session: Session,
  key: SessionSettingKey,
  value: string
): Session {
  switch (key) {
    case 'backend':
      return {
        ...session,
        backend: value as Backend,
      }
    case 'model':
      return {
        ...session,
        selected_model: value,
      }
    case 'thinkingLevel':
      return {
        ...session,
        selected_thinking_level: value as ThinkingLevel,
      }
    case 'effortLevel':
      return {
        ...session,
        selected_effort_level: value as EffortLevel,
      }
    case 'executionMode':
      return {
        ...session,
        selected_execution_mode: value as ExecutionMode,
      }
    case 'permissionMode':
      return { ...session, selected_permission_mode: value as PermissionMode }
    case 'provider':
      return {
        ...session,
        selected_provider: normalizeProviderSettingValue(value),
      }
    case 'waitingForInput':
      // Handled in Zustand (useStreamingEvents), not session metadata
      return session
  }
}
