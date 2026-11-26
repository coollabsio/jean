import { useEffect, useState } from 'react'

/** DOM id of the title bar slot that shows the session view's breadcrumb. */
export const TITLEBAR_BREADCRUMB_SLOT_ID = 'titlebar-breadcrumb-slot'

/** Title bar breadcrumb slot element, or null when disabled or not mounted. */
export function useTitleBarBreadcrumbSlot(
  enabled: boolean
): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setSlot(
      enabled ? document.getElementById(TITLEBAR_BREADCRUMB_SLOT_ID) : null
    )
  }, [enabled])
  return slot
}
