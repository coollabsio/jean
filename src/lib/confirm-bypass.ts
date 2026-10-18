import { isClientMacOS } from '@/lib/platform'
import {
  CLOSE_CONFIRM_BYPASS_MODIFIERS,
  DEFAULT_CLOSE_CONFIRM_BYPASS_MODIFIER,
  type CloseConfirmBypassModifier,
} from '@/types/preferences'

/**
 * Coerce an arbitrary stored string to a known modifier, defaulting when it is
 * unknown. Rust persists this as a plain `String`, so a hand-edited
 * localStorage entry or a web-access client can store anything — validate here,
 * the single place both helpers and `normalize()` route through.
 */
export function resolveCloseConfirmBypassModifier(
  modifier: string | undefined
): CloseConfirmBypassModifier {
  return (CLOSE_CONFIRM_BYPASS_MODIFIERS as readonly string[]).includes(
    modifier ?? ''
  )
    ? (modifier as CloseConfirmBypassModifier)
    : DEFAULT_CLOSE_CONFIRM_BYPASS_MODIFIER
}

/**
 * Modifier flags shared by `MouseEvent` and `KeyboardEvent`, so one helper
 * serves the tab X button, middle-clicks and the Cmd+W keybinding alike.
 */
type ModifierState = Pick<
  KeyboardEvent,
  'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

/** Did the user hold the configured "skip the close confirmation" modifier? */
export function hasCloseConfirmBypassModifier(
  e: ModifierState | null | undefined,
  modifier: CloseConfirmBypassModifier | undefined
): boolean {
  if (!e) return false
  switch (resolveCloseConfirmBypassModifier(modifier)) {
    case 'shift':
      return e.shiftKey
    case 'alt':
      return e.altKey
    case 'none':
      return false
  }
}

/** Label for dialog hints and the settings picker. `null` when disabled. */
export function closeConfirmBypassLabel(
  modifier: CloseConfirmBypassModifier | undefined
): string | null {
  switch (resolveCloseConfirmBypassModifier(modifier)) {
    case 'shift':
      return isClientMacOS ? '⇧' : 'Shift'
    case 'alt':
      return isClientMacOS ? '⌥' : 'Alt'
    case 'none':
      return null
  }
}

/**
 * Remove one modifier from a canonical shortcut string.
 * `('mod+shift+w', 'shift')` -> `'mod+w'`. Returns null when the modifier is
 * absent, is `'none'`, or when nothing but the modifier remains.
 */
export function stripShortcutModifier(
  shortcut: string,
  modifier: CloseConfirmBypassModifier | undefined
): string | null {
  if (!modifier || modifier === 'none') return null
  const parts = shortcut.split('+')
  const index = parts.indexOf(modifier)
  if (index === -1) return null
  const rest = parts.filter((_, i) => i !== index)
  return rest.length > 0 ? rest.join('+') : null
}

/** Detail payload of the `close-session-or-worktree` CustomEvent. */
export interface CloseSessionOrWorktreeDetail {
  bypassConfirm?: boolean
}

/** Read the bypass flag off a `close-session-or-worktree` event. */
export function readCloseBypassDetail(e: Event): boolean {
  return (
    (e as CustomEvent<CloseSessionOrWorktreeDetail>).detail?.bypassConfirm ===
    true
  )
}
