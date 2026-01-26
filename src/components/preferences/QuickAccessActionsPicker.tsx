import { Terminal, Play, Code, FolderOpen, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  quickAccessActionOptions,
  type QuickAccessAction,
} from '@/types/preferences'

interface QuickAccessActionsPickerProps {
  value: QuickAccessAction[]
  onChange: (actions: QuickAccessAction[]) => void
}

const actionIcons: Record<QuickAccessAction, typeof Terminal> = {
  terminal: Terminal,
  run: Play,
  editor: Code,
  finder: FolderOpen,
  terminal_app: Terminal,
}

const MAX_ACTIONS = 4

export function QuickAccessActionsPicker({
  value,
  onChange,
}: QuickAccessActionsPickerProps) {
  const isAtLimit = value.length >= MAX_ACTIONS

  const handleToggle = (action: QuickAccessAction) => {
    if (value.includes(action)) {
      // Remove action
      onChange(value.filter(a => a !== action))
    } else if (!isAtLimit) {
      // Add action only if not at limit
      onChange([...value, action])
    }
  }

  return (
    <div className="space-y-1.5 w-56">
      {quickAccessActionOptions.map(option => {
        const Icon = actionIcons[option.value]
        const isSelected = value.includes(option.value)
        const isDisabled = !isSelected && isAtLimit

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => handleToggle(option.value)}
            disabled={isDisabled}
            className={cn(
              'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
              isSelected
                ? 'border-primary bg-primary/5'
                : isDisabled
                  ? 'border-transparent opacity-40 cursor-not-allowed'
                  : 'border-transparent hover:bg-accent/50'
            )}
          >
            <div
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded border',
                isSelected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted-foreground/30'
              )}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </div>
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">{option.label}</span>
          </button>
        )
      })}

      {isAtLimit && (
        <p className="text-xs text-muted-foreground pt-1">
          Maximum {MAX_ACTIONS} actions allowed
        </p>
      )}
    </div>
  )
}
