import { useSyncExternalStore } from 'react'

/** Title bar slot that shows the session / project name. */
export const TITLEBAR_BREADCRUMB_SLOT_ID = 'titlebar-breadcrumb-slot'

/** Title bar slot (next to Settings) for the project or worktree menu. */
export const TITLEBAR_PROJECT_MENU_SLOT_ID = 'titlebar-project-menu-slot'

/** Title bar slot (right side) for the view actions. */
export const TITLEBAR_ACTIONS_SLOT_ID = 'titlebar-actions-slot'

/** Title bar slot (left of the right-panel toggle) for right panel actions. */
export const TITLEBAR_RIGHT_PANEL_SLOT_ID = 'titlebar-right-panel-slot'

/** Title bar slot (left of the right-panel toggle) for the thread details button. */
export const TITLEBAR_THREAD_DETAILS_SLOT_ID = 'titlebar-thread-details-slot'

/** Title bar slot (center) for the view search box. */
export const TITLEBAR_CENTER_SLOT_ID = 'titlebar-center-slot'

const slots = new Map<string, HTMLElement>()
const listeners = new Set<() => void>()
const refCallbacks = new Map<string, (el: HTMLElement | null) => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Ref callback for the title bar element that hosts a slot. */
export function titleBarSlotRef(slotId: string) {
  let ref = refCallbacks.get(slotId)
  if (!ref) {
    ref = (el: HTMLElement | null) => {
      if (el) slots.set(slotId, el)
      else slots.delete(slotId)
      listeners.forEach(listener => listener())
    }
    refCallbacks.set(slotId, ref)
  }
  return ref
}

/** Title bar slot element, or null when disabled or not mounted. */
export function useTitleBarSlot(
  slotId: string,
  enabled: boolean
): HTMLElement | null {
  const slot = useSyncExternalStore(
    subscribe,
    () => slots.get(slotId) ?? null,
    () => null
  )
  return enabled ? slot : null
}
