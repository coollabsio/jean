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
import {
  SCHEDULE_EVENTS,
  emptyScheduleForm,
  formFromSchedule,
  formatScheduleWhen,
  scheduleInputFromForm,
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
      className="space-y-3 rounded-md border px-3 py-3"
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
          <div className="space-y-1">
            <Label htmlFor="schedule-delay">Delay (minutes)</Label>
            <Input
              id="schedule-delay"
              className="w-28"
              inputMode="numeric"
              value={form.delayMinutes}
              onChange={event =>
                onChange({ ...form, delayMinutes: event.target.value })
              }
            />
          </div>
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
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={pending || (attempted && Boolean(error))}
        >
          {form.scheduleId === null ? 'Create' : 'Save'}
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onClose}>
          Cancel
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
    <li className="flex items-start gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="truncate text-foreground">{schedule.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatScheduleWhen(schedule)}
            {schedule.lastRunAt && !schedule.event
              ? ` · last ran ${formatRelative(schedule.lastRunAt)}`
              : ''}
          </span>
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {schedule.prompt}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={schedule.paused ? 'Resume routine' : 'Pause routine'}
          disabled={update.isPending}
          onClick={() =>
            update.mutate(
              { agentId, scheduleId: schedule.id, paused: !schedule.paused },
              { onError }
            )
          }
        >
          {schedule.paused ? <Play /> : <PauseCircle />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Edit routine"
          onClick={() => onEdit(schedule)}
        >
          <Pencil />
        </Button>
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

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Each run starts a background task. Cron uses a 5-field expression in
          the chosen timezone. Events wake the agent when something already
          happens in Jean.
        </p>
        {form === null && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setForm(emptyScheduleForm())}
          >
            <Plus />
            New routine
          </Button>
        )}
      </div>
      {agent.paused && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          The agent is stopped. Schedules do not run until you resume it.
        </p>
      )}
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
        <p className="text-xs text-muted-foreground">Loading schedules…</p>
      ) : data?.schedules.length ? (
        <ul className="space-y-2">
          {data.schedules.map(schedule => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              agentId={agent.id}
              onEdit={item => setForm(formFromSchedule(item))}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No schedules.</p>
      )}
    </div>
  )
}
