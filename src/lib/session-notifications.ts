/**
 * Native desktop notifications for session lifecycle events.
 * Fires an OS banner only when Jean is in the background — when the window is
 * focused the existing notification sound already covers the event.
 */

import { invoke } from '@/lib/transport'
import { isNativeApp } from './environment'

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
