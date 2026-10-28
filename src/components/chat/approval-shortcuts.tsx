import { useEffect, useEffectEvent } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { usePreferences } from '@/services/preferences'
import {
  DEFAULT_KEYBINDINGS,
  formatShortcutDisplay,
  type KeybindingAction,
} from '@/types/keybindings'

type ApprovalShortcutAction =
  | 'approve_plan'
  | 'approve_plan_yolo'
  | 'deny_permission'

const KBD_TONE: Record<ApprovalShortcutAction, string> = {
  approve_plan: 'bg-primary-foreground/20 text-primary-foreground',
  approve_plan_yolo: 'bg-white/20 text-white',
  deny_permission: 'bg-foreground/10 text-secondary-foreground',
}

/** Shortcut hint for an approval card button, using the user's keybinding. */
export function ApprovalShortcutKbd({
  action,
}: {
  action: ApprovalShortcutAction
}) {
  const { data: preferences } = usePreferences()
  const shortcut = formatShortcutDisplay(
    preferences?.keybindings?.[action satisfies KeybindingAction] ??
      DEFAULT_KEYBINDINGS[action]
  )
  if (!shortcut) return null
  return (
    <Kbd
      aria-hidden="true"
      modHint
      className={cn('ml-1.5 h-4 text-2xs', KBD_TONE[action])}
    >
      {shortcut}
    </Kbd>
  )
}

/**
 * Wire the global approve / Full access / deny keybindings to an approval
 * card. Pass `undefined` for a handler the card does not offer.
 */
export function useApprovalShortcuts({
  enabled = true,
  onApprove,
  onApproveYolo,
  onDeny,
}: {
  enabled?: boolean
  onApprove?: () => void
  onApproveYolo?: () => void
  onDeny?: () => void
}) {
  const approve = useEffectEvent(() => onApprove?.())
  const approveYolo = useEffectEvent(() => onApproveYolo?.())
  const deny = useEffectEvent(() => onDeny?.())

  useEffect(() => {
    if (!enabled) return
    const listeners: [string, () => void][] = [
      ['answer-question', () => approve()],
      ['approve-plan-yolo', () => approveYolo()],
      ['deny-permission', () => deny()],
    ]
    for (const [name, handler] of listeners)
      window.addEventListener(name, handler)
    return () => {
      for (const [name, handler] of listeners)
        window.removeEventListener(name, handler)
    }
  }, [enabled])
}
