import {
  ClipboardList,
  Hammer,
  Shield,
  Sparkles,
  Zap,
} from '@/components/icons/reicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useChatStore } from '@/store/chat-store'
import {
  getSupportedPermissionModes,
  permissionModeForExecution,
  type Backend,
  type ExecutionMode,
  type PermissionMode,
} from '@/types/chat'
import { cn } from '@/lib/utils'

interface ExecutionModeDropdownProps {
  executionMode: ExecutionMode
  availableModes?: ExecutionMode[]
  backend?: Backend
  sessionId?: string | null
  disabled?: boolean
  onSetExecutionMode: (mode: ExecutionMode) => void
  className?: string
  align?: 'start' | 'center' | 'end'
  onCloseAutoFocus?: (event: Event) => void
}

const PERMISSIONS: Record<
  PermissionMode,
  { label: string; description: string; icon: typeof Shield }
> = {
  supervised: {
    label: 'Supervised',
    description: 'Ask before changes and commands that need approval.',
    icon: Shield,
  },
  build: {
    label: 'Auto-accept edits',
    description: 'Allow edits. Ask for other actions that need approval.',
    icon: Hammer,
  },
  auto: {
    label: 'Auto',
    description: 'The backend reviews approval requests automatically.',
    icon: Sparkles,
  },
  yolo: {
    label: 'Full access',
    description: 'Allow commands and edits without approval prompts.',
    icon: Zap,
  },
}

/** Permission selector; existing wire modes remain compatible. */
export function ExecutionModeDropdown({
  executionMode,
  availableModes,
  backend,
  sessionId,
  disabled = false,
  onSetExecutionMode,
  className,
  align = 'start',
  onCloseAutoFocus,
}: ExecutionModeDropdownProps) {
  const rememberedPermission = useChatStore(state =>
    sessionId ? state.permissionModes[sessionId] : undefined
  )
  const isPlan = executionMode === 'plan'
  const permission = isPlan
    ? (rememberedPermission ?? (sessionId ? 'build' : 'yolo'))
    : permissionModeForExecution(executionMode)
  const supported = getSupportedPermissionModes(backend).filter(
    mode => !availableModes || availableModes.includes(mode)
  )
  const planAvailable = !availableModes || availableModes.includes('plan')
  const isLegacy = permission === 'build' && !supported.includes('build')
  const active = PERMISSIONS[permission]
  const PermissionIcon = isPlan ? ClipboardList : active.icon
  const triggerLabel = isPlan
    ? 'Plan'
    : isLegacy
      ? 'Legacy Build'
      : active.label

  return (
    <div className={cn('flex items-center shrink-0', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={
              isPlan ? 'Workflow: Plan' : `Permissions: ${triggerLabel}`
            }
            disabled={disabled}
            className={cn(
              'flex h-8 items-center gap-1.5 px-2 text-xs font-medium hover:bg-muted/80 disabled:opacity-50',
              isPlan
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-muted-foreground'
            )}
          >
            <PermissionIcon
              className={cn(
                'h-3.5 w-3.5',
                !isPlan && permission === 'yolo' && 'text-red-500'
              )}
            />
            <span>{triggerLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          onCloseAutoFocus={onCloseAutoFocus}
          className="w-80 max-w-[calc(100vw-1rem)]"
        >
          <DropdownMenuRadioGroup
            value={isPlan ? 'plan' : permission}
            onValueChange={value => {
              if (value === 'plan') {
                onSetExecutionMode('plan')
                return
              }
              const next = value as PermissionMode
              if (sessionId)
                useChatStore.getState().setPermissionMode(sessionId, next)
              onSetExecutionMode(next)
            }}
          >
            {planAvailable && (
              <DropdownMenuRadioItem
                value="plan"
                className="items-start pl-2 [&>span]:hidden dark:data-[state=checked]:bg-yellow-400 dark:data-[state=checked]:text-zinc-950 dark:data-[state=checked]:[&_svg]:text-zinc-950 dark:data-[state=checked]:[&_.text-muted-foreground]:text-zinc-800"
              >
                <ClipboardList className="mr-2 mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                <div>
                  <div>Plan</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Explore and propose a plan. No code changes until you
                    approve.
                  </div>
                </div>
              </DropdownMenuRadioItem>
            )}
            {planAvailable && supported.length > 0 && <DropdownMenuSeparator />}
            {planAvailable && supported.length > 0 && (
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Permissions
              </DropdownMenuLabel>
            )}
            {supported.map(mode => {
              const meta = PERMISSIONS[mode]
              const Icon = meta.icon
              return (
                <DropdownMenuRadioItem
                  key={mode}
                  value={mode}
                  className="items-start pl-2 [&>span]:hidden dark:data-[state=checked]:bg-yellow-400 dark:data-[state=checked]:text-zinc-950 dark:data-[state=checked]:[&_svg]:text-zinc-950 dark:data-[state=checked]:[&_.text-muted-foreground]:text-zinc-800"
                >
                  <Icon
                    className={cn(
                      'mr-2 mt-0.5 h-4 w-4 shrink-0',
                      mode === 'yolo' && 'text-red-500!'
                    )}
                  />
                  <div>
                    <div>{meta.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {mode === 'build' && backend === 'codex'
                        ? 'Allow workspace edits and sandboxed commands. Ask for escalation.'
                        : meta.description}
                    </div>
                  </div>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
