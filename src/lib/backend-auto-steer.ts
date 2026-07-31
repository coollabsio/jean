import type { Backend } from '@/types/chat'

/** Preference fields that control whether a running turn is steered vs queued. */
export interface AutoSteerPreferences {
  codex_auto_steer_enabled?: boolean
  opencode_auto_steer_enabled?: boolean
  pi_auto_steer_enabled?: boolean
  grok_auto_steer_enabled?: boolean
  kimi_auto_steer_enabled?: boolean
}

/** Backends that support steering a prompt into a running turn. */
export function isSteerCapableBackend(
  backend: Backend | string | null | undefined
): boolean {
  return (
    backend === 'codex' ||
    backend === 'opencode' ||
    backend === 'pi' ||
    backend === 'grok'
  )
}

/**
 * Whether submitting while a session is already sending should steer into the
 * running turn (instead of queueing) for this backend.
 */
export function isBackendAutoSteerEnabled(
  backend: Backend | string | null | undefined,
  preferences?: AutoSteerPreferences | null
): boolean {
  if (!isSteerCapableBackend(backend)) return false

  switch (backend) {
    case 'opencode':
      return preferences?.opencode_auto_steer_enabled ?? true
    case 'pi':
      return preferences?.pi_auto_steer_enabled ?? true
    case 'grok':
      return preferences?.grok_auto_steer_enabled ?? true
    case 'codex':
    default:
      return preferences?.codex_auto_steer_enabled ?? true
  }
}
