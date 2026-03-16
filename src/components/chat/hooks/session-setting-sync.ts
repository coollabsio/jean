import type { Backend, ExecutionMode, Session, ThinkingLevel } from '@/types/chat'

export type SessionSettingKey =
  | 'backend'
  | 'model'
  | 'thinkingLevel'
  | 'executionMode'
  | 'waitingForInput'

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
    case 'executionMode':
      return {
        ...session,
        selected_execution_mode: value as ExecutionMode,
      }
    case 'waitingForInput':
      // Handled in Zustand (useStreamingEvents), not session metadata
      return session
  }
}
