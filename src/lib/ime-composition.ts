/**
 * Detect keyboard events that belong to an active IME composition session
 * (Japanese / Chinese / Korean conversion, etc.).
 *
 * App shortcuts that treat Enter/Tab as "submit" or "select" must ignore these
 * events so confirming a conversion does not also fire the shortcut.
 *
 * Checks both:
 * - `isComposing` — set during composition on Chromium/Firefox/modern WebKit
 * - `keyCode === 229` — legacy IME keydown code; required on Safari/WKWebView
 *   where `compositionend` can run before the confirming Enter `keydown`,
 *   leaving `isComposing` already false for that key event
 *
 * Accepts either a native KeyboardEvent or a React synthetic keyboard event.
 */
export function isImeComposingEvent(
  event:
    | Pick<KeyboardEvent, 'isComposing' | 'keyCode'>
    | { nativeEvent: Pick<KeyboardEvent, 'isComposing' | 'keyCode'> }
): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing === true || native.keyCode === 229
}
