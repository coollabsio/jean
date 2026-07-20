import { Kbd } from '@/components/ui/kbd'
import { isNativeApp } from '@/lib/environment'
import { isClientMacOS } from '@/lib/platform'

export const TOAST_ACTION_SHORTCUT = {
  shortcut: 'alt+enter',
} as const

export function getToastActionShortcutLabel(): string {
  return isClientMacOS ? '⌥↩' : 'Alt+Enter'
}

function shouldShowToastActionShortcut(): boolean {
  return (
    isNativeApp() && (typeof window === 'undefined' || window.innerWidth >= 768)
  )
}

export function ToastActionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{children}</span>
      {shouldShowToastActionShortcut() && (
        <Kbd className="h-4 min-w-0 bg-primary-foreground/20 px-1 text-[10px] text-primary-foreground">
          {getToastActionShortcutLabel()}
        </Kbd>
      )}
    </span>
  )
}

export function toastActionLabel(label: React.ReactNode) {
  return <ToastActionLabel>{label}</ToastActionLabel>
}
