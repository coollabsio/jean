/**
 * Native desktop notifications for session lifecycle events.
 * Fires an OS banner only when Jean is in the background — when the window is
 * focused the existing notification sound already covers the event.
 */

import { invoke } from '@/lib/transport'
import { isNativeApp } from './environment'

/**
 * Ask the native backend to fire an OS banner when the app is unfocused.
 * Native window focus is checked in Rust because `document.hasFocus()` can be
 * stale while a desktop webview is backgrounded.
 */
export function notifyIfBackground(title: string, body?: string): void {
  if (!isNativeApp()) return
  void invoke('send_native_notification', {
    title,
    body,
    backgroundOnly: true,
  }).catch(() => undefined)
}
