/**
 * Native desktop notifications for session lifecycle events.
 *
 * - When Jean is unfocused: always fire an OS banner (if enabled).
 * - When Jean is focused on a *different* session/view: also fire an OS banner
 *   so mid-turn Codex/Claude approvals aren't silent (issue #626).
 * - When Jean is focused on the session that needs input: skip the banner —
 *   the in-app UI + optional waiting sound already cover it.
 */

import { invoke } from '@/lib/transport'
import { isNativeApp } from './environment'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'

/**
 * Fire a native OS banner only when the app is unfocused.
 * No-op in web access (non-native) or when the window is focused.
 */
export function notifyIfBackground(title: string, body?: string): void {
  if (!isNativeApp()) return
  if (document.hasFocus()) return // sound already covers the focused case
  void invoke('send_native_notification', { title, body }).catch(
    () => undefined
  )
}

/** Whether the given session is currently open in the full chat view or modal. */
export function isSessionCurrentlyViewed(sessionId: string): boolean {
  const {
    activeWorktreeId,
    activeSessionIds,
    sessionWorktreeMap,
  } = useChatStore.getState()
  const worktreeId = sessionWorktreeMap[sessionId]
  if (!worktreeId) return false

  const isActiveSession = activeSessionIds[worktreeId] === sessionId
  if (!isActiveSession) return false

  if (activeWorktreeId === worktreeId) return true

  const { sessionChatModalOpen, sessionChatModalWorktreeId } =
    useUIStore.getState()
  return sessionChatModalOpen && sessionChatModalWorktreeId === worktreeId
}

/**
 * Notify the user that a session needs attention (approval/input).
 *
 * Fires a native OS banner when:
 * - the window is unfocused, OR
 * - the window is focused but the user is not viewing this session
 *
 * Always pairs with playWaitingSound in callers for the focused-on-session case.
 */
export function notifySessionNeedsAttention(
  sessionId: string,
  title: string,
  body?: string
): void {
  if (!isNativeApp()) return

  const viewingThisSession = isSessionCurrentlyViewed(sessionId)
  if (document.hasFocus() && viewingThisSession) {
    // User can already see the approval UI; sound (if configured) is enough.
    return
  }

  void invoke('send_native_notification', { title, body }).catch(
    () => undefined
  )
}
