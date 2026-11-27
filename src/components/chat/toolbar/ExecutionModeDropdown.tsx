import {
  Check,
  ChevronsUpDown,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { BOTTOM_SHEET_ROW_CLASS } from '@/components/ui/bottom-sheet'
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
  /** Show only the mode icon; the label moves to a tooltip */
  iconOnly?: boolean
  /** Set false when nested in a popover, so the popover keeps pointer events */
  modal?: boolean
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

/** Icon tone per mode: the one place plan and permission colours live. */
const MODE_TONE: Record<'plan' | PermissionMode, string> = {
  plan: 'text-info',
  supervised: 'text-muted-foreground',
  build: 'text-warning',
  auto: 'text-muted-foreground',
  yolo: 'text-destructive',
}

const MODE_ITEM_CLASS =
  'items-start pl-2 [&>span]:hidden data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground'

interface ExecutionModeSelection {
  executionMode: ExecutionMode
  availableModes?: ExecutionMode[]
  backend?: Backend
  sessionId?: string | null
}

/** Resolves the active mode and its icon, tone, and label. */
export function useExecutionModeDisplay({
  executionMode,
  availableModes,
  backend,
  sessionId,
}: ExecutionModeSelection) {
  const rememberedPermission = useChatStore(state =>
    sessionId ? state.permissionModes[sessionId] : undefined
  )
  const isPlan = executionMode === 'plan'
  const permission = isPlan
    ? (rememberedPermission ?? (sessionId ? 'build' : 'yolo'))
    : permissionModeForExecution(executionMode)
  const supported = getSupportedPermissionModes(backend).filter(
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- at most three execution modes
    mode => !availableModes || availableModes.includes(mode)
  )
  const isLegacy = permission === 'build' && !supported.includes('build')
  const label = isPlan
    ? 'Plan'
    : isLegacy
      ? 'Legacy Build'
      : PERMISSIONS[permission].label
  return {
    isPlan,
    permission,
    supported,
    planAvailable: !availableModes || availableModes.includes('plan'),
    Icon: isPlan ? ClipboardList : PERMISSIONS[permission].icon,
    tone: MODE_TONE[isPlan ? 'plan' : permission],
    label,
    ariaLabel: isPlan ? 'Workflow: Plan' : `Permissions: ${label}`,
  }
}

interface ExecutionModeRadioGroupProps extends ExecutionModeSelection {
  onSetExecutionMode: (mode: ExecutionMode) => void
}

function selectExecutionMode(
  value: string,
  sessionId: string | null | undefined,
  onSetExecutionMode: (mode: ExecutionMode) => void
) {
  if (value === 'plan') {
    onSetExecutionMode('plan')
    return
  }
  const next = value as PermissionMode
  if (sessionId) useChatStore.getState().setPermissionMode(sessionId, next)
  onSetExecutionMode(next)
}

function permissionDescription(mode: PermissionMode, backend?: Backend) {
  return mode === 'build' && backend === 'codex'
    ? 'Allow workspace edits and sandboxed commands. Ask for escalation.'
    : PERMISSIONS[mode].description
}

const PLAN_DESCRIPTION =
  'Explore and propose a plan. No code changes until you approve.'

/** Plan + permission radio items; render inside a dropdown (sub)menu. */
export function ExecutionModeRadioGroup({
  onSetExecutionMode,
  ...selection
}: ExecutionModeRadioGroupProps) {
  const { backend, sessionId } = selection
  const { isPlan, permission, supported, planAvailable } =
    useExecutionModeDisplay(selection)

  return (
    <DropdownMenuRadioGroup
      value={isPlan ? 'plan' : permission}
      onValueChange={value =>
        selectExecutionMode(value, sessionId, onSetExecutionMode)
      }
    >
      {planAvailable && (
        <DropdownMenuRadioItem value="plan" className={MODE_ITEM_CLASS}>
          <ClipboardList
            className={cn('mr-2 mt-0.5 h-4 w-4 shrink-0', MODE_TONE.plan)}
          />
          <div>
            <div>Plan</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {PLAN_DESCRIPTION}
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
            className={MODE_ITEM_CLASS}
          >
            <Icon
              className={cn('mr-2 mt-0.5 h-4 w-4 shrink-0', MODE_TONE[mode])}
            />
            <div>
              <div>{meta.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {permissionDescription(mode, backend)}
              </div>
            </div>
          </DropdownMenuRadioItem>
        )
      })}
    </DropdownMenuRadioGroup>
  )
}

interface ExecutionModeSheetOptionsProps extends ExecutionModeRadioGroupProps {
  /** Runs after a mode is picked, e.g. to close the sheet. */
  onSelected?: () => void
}

/** Plan + permission rows for a mobile bottom sheet. */
export function ExecutionModeSheetOptions({
  onSetExecutionMode,
  onSelected,
  ...selection
}: ExecutionModeSheetOptionsProps) {
  const { backend, sessionId } = selection
  const { isPlan, permission, supported, planAvailable } =
    useExecutionModeDisplay(selection)
  const current = isPlan ? 'plan' : permission
  const options = [
    ...(planAvailable
      ? [
          {
            value: 'plan',
            label: 'Plan',
            description: PLAN_DESCRIPTION,
            Icon: ClipboardList,
            tone: MODE_TONE.plan,
          },
        ]
      : []),
    ...supported.map(mode => ({
      value: mode,
      label: PERMISSIONS[mode].label,
      description: permissionDescription(mode, backend),
      Icon: PERMISSIONS[mode].icon,
      tone: MODE_TONE[mode],
    })),
  ]

  return options.map(({ value, label, description, Icon, tone }) => {
    const selected = value === current
    return (
      <button
        key={value}
        type="button"
        className={cn(BOTTOM_SHEET_ROW_CLASS, 'py-2', selected && 'bg-accent')}
        aria-pressed={selected}
        onClick={() => {
          selectExecutionMode(value, sessionId, onSetExecutionMode)
          onSelected?.()
        }}
      >
        <Icon className={cn('h-4 w-4 shrink-0', tone)} />
        <span className="flex-1">
          <span className="block font-medium">{label}</span>
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        </span>
        {selected && <Check className="h-4 w-4 shrink-0" />}
      </button>
    )
  })
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
  iconOnly = false,
  modal = true,
}: ExecutionModeDropdownProps) {
  const selection = { executionMode, availableModes, backend, sessionId }
  const { Icon, tone, label, ariaLabel } = useExecutionModeDisplay(selection)

  return (
    <div className={cn('flex items-center shrink-0', className)}>
      <DropdownMenu modal={modal}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={ariaLabel}
                disabled={disabled}
                className="flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
              >
                <Icon className={cn('h-3.5 w-3.5', tone)} />
                {!iconOnly && (
                  <>
                    <span>{label}</span>
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {iconOnly && <TooltipContent>{ariaLabel}</TooltipContent>}
        </Tooltip>
        <DropdownMenuContent
          align={align}
          onCloseAutoFocus={onCloseAutoFocus}
          className="w-80 max-w-[calc(100vw-1rem)]"
        >
          <ExecutionModeRadioGroup
            {...selection}
            onSetExecutionMode={onSetExecutionMode}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
