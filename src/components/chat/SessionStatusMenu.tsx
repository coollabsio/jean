import { Check, CircleDashed } from 'lucide-react'
import { StatusIndicator } from '@/components/ui/status-indicator'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import {
  MANUAL_SESSION_STATUSES,
  statusConfig,
  type ManualSessionStatus,
  type SessionStatus,
} from './session-card-utils'

const MANUAL_STATUS_ITEMS: {
  value: ManualSessionStatus
  status: SessionStatus
}[] = MANUAL_SESSION_STATUSES.map(value => ({
  value,
  status: value,
}))

interface SessionStatusMenuProps {
  /** Active manual override, if any. */
  statusOverride: ManualSessionStatus | null
  /** Automatic status before override. */
  automaticStatus: SessionStatus
  onSetStatusOverride: (status: ManualSessionStatus | null) => void
}

/**
 * Context-menu submenu for setting a manual session status (Helmor-style).
 * "Automatic" clears the override so live status computation takes over.
 */
export function SessionStatusMenu({
  statusOverride,
  automaticStatus,
  onSetStatusOverride,
}: SessionStatusMenuProps) {
  const automaticConfig = statusConfig[automaticStatus]

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
          <StatusIndicator
            status={
              statusOverride
                ? statusConfig[statusOverride].indicatorStatus
                : automaticConfig.indicatorStatus
            }
            variant={
              statusOverride
                ? statusConfig[statusOverride].indicatorVariant
                : automaticConfig.indicatorVariant
            }
            shape={
              statusOverride
                ? statusConfig[statusOverride].indicatorShape
                : automaticConfig.indicatorShape
            }
            className="h-2 w-2"
          />
        </span>
        Set Status
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-52">
        <ContextMenuItem
          onSelect={() => onSetStatusOverride(null)}
          className="gap-2"
        >
          <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="flex-1">Automatic</span>
          <span className="text-[10px] text-muted-foreground">
            {automaticConfig.label}
          </span>
          {!statusOverride && <Check className="h-3.5 w-3.5" />}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {MANUAL_STATUS_ITEMS.map(({ value, status }) => {
          const config = statusConfig[status]
          const isSelected = statusOverride === value
          return (
            <ContextMenuItem
              key={value}
              onSelect={() => onSetStatusOverride(value)}
              className="gap-2"
            >
              <StatusIndicator
                status={config.indicatorStatus}
                variant={config.indicatorVariant}
                shape={config.indicatorShape}
                label={config.label}
                className="h-2 w-2"
              />
              <span className="flex-1">{config.label}</span>
              {isSelected && <Check className="h-3.5 w-3.5" />}
            </ContextMenuItem>
          )
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
