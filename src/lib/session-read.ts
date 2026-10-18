import { invoke } from '@/lib/transport'
import { isSessionCurrentlyViewed } from '@/lib/session-notifications'

/** Sessions that finished on screen while this window had no focus. */
const pendingUntilFocus = new Set<string>()

/** Set last_opened_at so the session leaves the unread list. */
export function markSessionOpened(sessionId: string): void {
  invoke('set_session_last_opened', { sessionId })
    .then(() => window.dispatchEvent(new CustomEvent('session-opened')))
    .catch(() => undefined)
}

function flushPendingUntilFocus(): void {
  window.removeEventListener('focus', flushPendingUntilFocus)
  for (const sessionId of pendingUntilFocus) {
    if (isSessionCurrentlyViewed(sessionId)) markSessionOpened(sessionId)
  }
  pendingUntilFocus.clear()
}

/**
 * Mark a session read after its run ends while it is open in this window.
 *
 * An open modal is not proof that the user saw the result: the window can be
 * in the background (another app, another browser tab, or another Jean client
 * the user is looking at). Marking read then hides the session from the unread
 * indicator on every client. So only mark read when the window has focus;
 * otherwise wait for focus and check that the session is still on screen.
 */
export function markSessionOpenedWhenSeen(sessionId: string): void {
  if (document.hasFocus()) {
    markSessionOpened(sessionId)
    return
  }
  if (pendingUntilFocus.size === 0) {
    window.addEventListener('focus', flushPendingUntilFocus)
  }
  pendingUntilFocus.add(sessionId)
}
