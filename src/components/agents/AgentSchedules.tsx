import { useState } from 'react'
import { toast } from 'sonner'
import {
  PauseCircle,
  Pencil,
  Play,
  Plus,
  Trash2,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import {
  useAgentDetails,
  useCancelAgentSchedule,
  useCreateAgentSchedule,
  useUpdateAgentSchedule,
  type AgentSchedule,
  type AgentSummary,
  type ScheduleKind,
} from '@/services/agents'
import { formatRelative } from './AgentActivity'
import { cn } from '@/lib/utils'
import {
  AgentBadge,
  AgentEmpty,
  AgentList,
  AgentLoading,
  AgentSection,
  AgentTabBody,
} from './agent-ui'
import {
  SCHEDULE_EVENTS,
  emptyScheduleForm,
  formFromSchedule,
  formatScheduleWhen,
  scheduleInputFromForm,
  scheduleKindLabel,
  scheduleUpdateFromForm,
  timezoneOptions,
  validateScheduleForm,
  type ScheduleForm,
} from './schedule-form'

export { formatInterval } from './schedule-form'

const KIND_LABELS: Record<ScheduleKind, string> = {
  once: 'Once',
  interval: 'Interval',
  cron: 'Cron',
  event: 'Event',
}

function ScheduleEditor({
  form,
  pending,
  onChange,
  onClose,
  onSave,
}: {
  form: ScheduleForm
  pending: boolean
  onChange: (form: ScheduleForm) => void
  onClose: () => void
  onSave: () => void
}) {
  const [attempted, setAttempted] = useState(false)
  const error = validateScheduleForm(form)
  const zones = timezoneOptions(form.timezone)
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={event => {
        event.preventDefault()
        setAttempted(true)
        if (!error) onSave()
      }}
    >
      <p className="text-sm font-medium">
        {form.scheduleId === null
          ? 'New routine'
          : `Edit routine #${form.scheduleId}`}
      </p>
      <div className="space-y-1">
        <Label htmlFor="schedule-name">Name</Label>
        <Input
          id="schedule-name"
          value={form.name}
          maxLength={200}
          placeholder="Weekday standup"
          onChange={event => onChange({ ...form, name: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="schedule-prompt">Prompt</Label>
        <Textarea
          id="schedule-prompt"
          value={form.prompt}
          rows={3}
          maxLength={8000}
          placeholder="Check open pull requests and tell me what needs a decision."
          onChange={event => onChange({ ...form, prompt: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="schedule-kind">When</Label>
          <NativeSelect
            id="schedule-kind"
            value={form.kind}
            aria-label="Schedule type"
            onChange={event =>
              onChange({ ...form, kind: event.target.value as ScheduleKind })
            }
          >
            {(Object.keys(KIND_LABELS) as ScheduleKind[]).map(kind => (
              <NativeSelectOption key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {form.kind === 'once' && (
          <>
            <div className="space-y-1">
              <Label htmlFor="schedule-run-at">Date and time</Label>
              <Input
                id="schedule-run-at"
                type="datetime-local"
                className="w-52"
                value={form.runAt}
                aria-invalid={attempted && Boolean(error)}
                onChange={event =>
                  onChange({ ...form, runAt: event.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="schedule-timezone">Timezone</Label>
              <NativeSelect
                id="schedule-timezone"
                value={form.timezone}
                aria-label="Timezone"
                onChange={event =>
                  onChange({ ...form, timezone: event.target.value })
                }
              >
                {zones.map(zone => (
                  <NativeSelectOption key={zone} value={zone}>
                    {zone}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </>
        )}
        {form.kind === 'interval' && (
          <>
            <div className="space-y-1">
              <Label htmlFor="schedule-every">Every</Label>
              <Input
                id="schedule-every"
                className="w-24"
                inputMode="numeric"
                value={form.everyAmount}
                onChange={event =>
                  onChange({ ...form, everyAmount: event.target.value })
                }
              />
            </div>
            <NativeSelect
              value={form.everyUnit}
              aria-label="Interval unit"
              onChange={event =>
                onChange({
                  ...form,
                  everyUnit: event.target.value as ScheduleForm['everyUnit'],
                })
              }
            >
              <NativeSelectOption value="minutes">minutes</NativeSelectOption>
              <NativeSelectOption value="hours">hours</NativeSelectOption>
              <NativeSelectOption value="days">days</NativeSelectOption>
            </NativeSelect>
          </>
        )}
        {form.kind === 'event' && (
          <div className="space-y-1">
            <Label htmlFor="schedule-event">Event</Label>
            <NativeSelect
              id="schedule-event"
              value={form.event}
              aria-label="Event"
              onChange={event =>
                onChange({
                  ...form,
                  event: event.target.value as ScheduleForm['event'],
                })
              }
            >
              {SCHEDULE_EVENTS.map(event => (
                <NativeSelectOption key={event.id} value={event.id}>
                  {event.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      {form.kind === 'cron' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="schedule-cron">Cron</Label>
            <Input
              id="schedule-cron"
              value={form.cron}
              spellCheck={false}
              placeholder="0 9 * * 1-5"
              aria-invalid={attempted && Boolean(error)}
              onChange={event =>
                onChange({ ...form, cron: event.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="schedule-timezone">Timezone</Label>
            <NativeSelect
              id="schedule-timezone"
              value={form.timezone}
              aria-label="Timezone"
              onChange={event =>
                onChange({ ...form, timezone: event.target.value })
              }
            >
              {zones.map(zone => (
                <NativeSelectOption key={zone} value={zone}>
                  {zone}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}
      {attempted && error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
      <div className="-mx-4 -mb-4 mt-1 flex justify-end gap-2 border-t bg-muted/20 px-4 py-2.5">
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          type="submit"
          disabled={pending || (attempted && Boolean(error))}
        >
          {form.scheduleId === null ? 'Create routine' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

function ScheduleRow({
  schedule,
  agentId,
  onEdit,
}: {
  schedule: AgentSchedule
  agentId: string
  onEdit: (schedule: AgentSchedule) => void
}) {
  const cancel = useCancelAgentSchedule()
  const update = useUpdateAgentSchedule()
  const onError = (error: unknown) => toast.error(`Failed: ${error}`)
  return (
    <li
      className={cn(
        'flex items-start gap-3 px-3 py-2.5',
        schedule.paused && 'opacity-70'
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium text-foreground">
            {schedule.name}
          </span>
          <AgentBadge>{scheduleKindLabel(schedule)}</AgentBadge>
          {schedule.paused && <AgentBadge tone="attention">Paused</AgentBadge>}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {formatScheduleWhen(schedule)}
          {schedule.lastRunAt && !schedule.event
            ? ` · last ran ${formatRelative(schedule.lastRunAt)}`
            : ''}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground/80">
          {schedule.prompt}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5 text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={schedule.paused ? 'Resume routine' : 'Pause routine'}
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  {
                    agentId,
                    scheduleId: schedule.id,
                    paused: !schedule.paused,
                  },
                  { onError }
                )
              }
            >
              {schedule.paused ? <Play /> : <PauseCircle />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {schedule.paused ? 'Resume' : 'Pause'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Edit routine"
              onClick={() => onEdit(schedule)}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete routine"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate({ agentId, scheduleId: schedule.id }, { onError })
              }
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </li>
  )
}

/** Routines of an agent. Each run starts a task (see Tasks). */
export function AgentSchedules({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const create = useCreateAgentSchedule()
  const update = useUpdateAgentSchedule()
  const [form, setForm] = useState<ScheduleForm | null>(null)
  const pending = create.isPending || update.isPending

  const save = () => {
    if (!form) return
    const input = scheduleInputFromForm(form)
    const onError = (error: unknown) => toast.error(`Failed: ${error}`)
    if (form.scheduleId === null) {
      create.mutate(
        { agentId: agent.id, ...input },
        { onSuccess: () => setForm(null), onError }
      )
      return
    }
    const original = data?.schedules.find(item => item.id === form.scheduleId)
    update.mutate(
      {
        agentId: agent.id,
        scheduleId: form.scheduleId,
        ...(original ? scheduleUpdateFromForm(form, original) : input),
      },
      { onSuccess: () => setForm(null), onError }
    )
  }

  const schedules = data?.schedules ?? []
  const newButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setForm(emptyScheduleForm())}
    >
      <Plus />
      New routine
    </Button>
  )

  return (
    <AgentTabBody>
      <AgentSection
        title="Routines"
        count={isLoading ? undefined : schedules.length}
        description="Each run starts a background task. Cron uses a 5-field expression in the chosen timezone. Events wake the agent when something happens in Jean."
        actions={form === null ? newButton : null}
      >
        {form && (
          <ScheduleEditor
            form={form}
            pending={pending}
            onChange={setForm}
            onClose={() => setForm(null)}
            onSave={save}
          />
        )}
        {isLoading ? (
          <AgentLoading label="Loading routines…" />
        ) : schedules.length ? (
          <AgentList>
            {schedules.map(schedule => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                agentId={agent.id}
                onEdit={item => setForm(formFromSchedule(item))}
              />
            ))}
          </AgentList>
        ) : form === null ? (
          <AgentEmpty title="No routines yet." />
        ) : null}
      </AgentSection>
    </AgentTabBody>
  )
}
