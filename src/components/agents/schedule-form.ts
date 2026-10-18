import type {
  AgentSchedule,
  ScheduleEvent,
  ScheduleInput,
  ScheduleKind,
} from '@/services/agents'
import { formatRelative } from './AgentActivity'

export const MIN_INTERVAL_MINUTES = 5
export const MIN_DELAY_MINUTES = 1
export const MAX_DELAY_MINUTES = 60 * 24 * 30

export const SCHEDULE_EVENTS: { id: ScheduleEvent; label: string }[] = [
  { id: 'session_finished', label: 'Session finished' },
  { id: 'session_failed', label: 'Session failed' },
  { id: 'worktree_archived', label: 'Worktree archived' },
  { id: 'pr_merged', label: 'Pull request merged' },
  { id: 'approval_resolved', label: 'Approval resolved' },
]

export const SCHEDULE_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

const EVENT_LABELS: Record<string, string> = Object.fromEntries(
  SCHEDULE_EVENTS.map(event => [event.id, event.label])
)

export interface ScheduleForm {
  scheduleId: number | null
  name: string
  prompt: string
  kind: ScheduleKind
  delayMinutes: string
  everyAmount: string
  everyUnit: 'minutes' | 'hours' | 'days'
  cron: string
  timezone: string
  event: ScheduleEvent
  paused: boolean
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function timezoneOptions(local = browserTimeZone()): string[] {
  if (!local || SCHEDULE_TIMEZONES.includes(local))
    return [...SCHEDULE_TIMEZONES]
  return [local, ...SCHEDULE_TIMEZONES]
}

/** "every 30m" / "every 2h" / "every 1d" for a repeat interval. */
export function formatInterval(everySecs: number): string {
  const minutes = Math.round(everySecs / 60)
  if (minutes % 1440 === 0) return `every ${minutes / 1440}d`
  if (minutes % 60 === 0) return `every ${minutes / 60}h`
  return `every ${minutes}m`
}

export function emptyScheduleForm(timezone = browserTimeZone()): ScheduleForm {
  return {
    scheduleId: null,
    name: '',
    prompt: '',
    kind: 'cron',
    delayMinutes: '10',
    everyAmount: '1',
    everyUnit: 'days',
    cron: '0 9 * * 1-5',
    timezone: timezoneOptions(timezone).includes(timezone) ? timezone : 'UTC',
    event: 'session_finished',
    paused: false,
  }
}

export function scheduleKind(schedule: AgentSchedule): ScheduleKind {
  if (schedule.event) return 'event'
  if (schedule.cron) return 'cron'
  if (schedule.everySecs) return 'interval'
  return 'once'
}

export function formFromSchedule(schedule: AgentSchedule): ScheduleForm {
  const form = emptyScheduleForm(schedule.timezone ?? undefined)
  form.scheduleId = schedule.id
  form.name = schedule.name
  form.prompt = schedule.prompt
  form.kind = scheduleKind(schedule)
  form.paused = schedule.paused
  form.cron = schedule.cron ?? form.cron
  form.timezone = schedule.timezone ?? form.timezone
  if (
    schedule.event &&
    SCHEDULE_EVENTS.some(event => event.id === schedule.event)
  ) {
    form.event = schedule.event as ScheduleEvent
  }
  if (schedule.everySecs) {
    const minutes = Math.round(schedule.everySecs / 60)
    if (minutes % 1440 === 0) {
      form.everyAmount = String(minutes / 1440)
      form.everyUnit = 'days'
    } else if (minutes % 60 === 0) {
      form.everyAmount = String(minutes / 60)
      form.everyUnit = 'hours'
    } else {
      form.everyAmount = String(minutes)
      form.everyUnit = 'minutes'
    }
  }
  return form
}

export function formatScheduleWhen(
  schedule: AgentSchedule,
  now = Date.now()
): string {
  const paused = schedule.paused ? ', paused' : ''
  if (schedule.event) {
    const label = EVENT_LABELS[schedule.event] ?? schedule.event
    const last = schedule.lastRunAt
      ? `, last ${formatRelative(schedule.lastRunAt, now)}`
      : ''
    return `on ${label}${paused}${last}`
  }
  if (schedule.cron) {
    const zone = schedule.timezone ? ` ${schedule.timezone}` : ''
    const next = schedule.paused
      ? 'paused'
      : `next ${formatRelative(schedule.nextRunAt, now)}`
    return `${schedule.cron}${zone}, ${next}`
  }
  if (schedule.everySecs) {
    const next = schedule.paused
      ? 'paused'
      : `next ${formatRelative(schedule.nextRunAt, now)}`
    return `${formatInterval(schedule.everySecs)}, ${next}`
  }
  const when = schedule.paused
    ? 'paused'
    : formatRelative(schedule.nextRunAt, now)
  return `once, ${when}`
}

function parsePositive(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

/** Minutes the cron minute field matches. Null when the field is invalid. */
export function cronMinutes(field: string): number[] | null {
  const minutes = new Set<number>()
  for (const part of field.split(',')) {
    const piece = part.trim()
    if (!piece) return null
    const [range, stepText] = piece.split('/')
    if (piece.split('/').length > 2) return null
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0 || range === undefined) return null
    let start: number
    let end: number
    if (range === '*') {
      start = 0
      end = 59
    } else if (range.includes('-')) {
      const [rawStart, rawEnd, extra] = range.split('-')
      if (extra !== undefined || rawStart === undefined || rawEnd === undefined)
        return null
      start = Number(rawStart)
      end = Number(rawEnd)
    } else {
      start = Number(range)
      // `N/step` means `N-59/step`, as in cronie and the server parser.
      end = stepText === undefined ? start : 59
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > 59 ||
      start > end
    ) {
      return null
    }
    for (let minute = start; minute <= end; minute += step) minutes.add(minute)
  }
  return [...minutes]
}

/**
 * Client check for a 5-field cron expression. The server repeats this with
 * timezone and DST-aware spacing; this catches the common mistakes first.
 */
export function validateCronExpression(expression: string): string | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    return 'Cron must have 5 fields: minute hour day-of-month month day-of-week'
  }
  const minutes = cronMinutes(fields[0] ?? '')
  if (!minutes || minutes.length === 0) {
    return 'Minute field is invalid. Use 0-59, a list, a range, or */5 and up.'
  }
  if (minutes.length > 1) {
    const sorted = [...minutes].sort((a, b) => a - b)
    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index] ?? 0
      const next = sorted[(index + 1) % sorted.length] ?? 0
      const gap = (next - current + 60) % 60
      if (gap !== 0 && gap < MIN_INTERVAL_MINUTES) {
        return `Minutes are ${gap} apart. The minimum spacing is 5 minutes.`
      }
    }
  }
  return null
}

export function everySecsFromForm(form: ScheduleForm): number | null {
  const amount = parsePositive(form.everyAmount)
  if (amount === null) return null
  const unit =
    form.everyUnit === 'days' ? 86_400 : form.everyUnit === 'hours' ? 3600 : 60
  return amount * unit
}

export function validateScheduleForm(form: ScheduleForm): string | null {
  if (!form.name.trim()) return 'Name is required'
  if (form.name.trim().length > 200) return 'Name is too long'
  if (!form.prompt.trim()) return 'Prompt is required'
  if (form.prompt.trim().length > 8000) return 'Prompt is too long'
  if (form.kind === 'once') {
    const delay = parsePositive(form.delayMinutes)
    if (
      delay === null ||
      delay < MIN_DELAY_MINUTES ||
      delay > MAX_DELAY_MINUTES
    ) {
      return `Delay must be between ${MIN_DELAY_MINUTES} and ${MAX_DELAY_MINUTES} minutes`
    }
  }
  if (form.kind === 'interval') {
    const every = everySecsFromForm(form)
    if (every === null || every < MIN_INTERVAL_MINUTES * 60) {
      return 'Interval must be at least 5 minutes'
    }
    if (every > MAX_DELAY_MINUTES * 60) return 'Interval is too long'
  }
  if (form.kind === 'cron') {
    const cronError = validateCronExpression(form.cron)
    if (cronError) return cronError
    if (!form.timezone.trim()) return 'Timezone is required'
  }
  if (
    form.kind === 'event' &&
    !SCHEDULE_EVENTS.some(event => event.id === form.event)
  ) {
    return 'Choose an event'
  }
  return null
}

export function scheduleInputFromForm(form: ScheduleForm): ScheduleInput {
  const base = {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    kind: form.kind,
    paused: form.paused,
  }
  if (form.kind === 'once') {
    return {
      ...base,
      delaySecs: Number(form.delayMinutes) * 60,
    }
  }
  if (form.kind === 'interval') {
    return { ...base, everySecs: everySecsFromForm(form) }
  }
  if (form.kind === 'cron') {
    return {
      ...base,
      cron: form.cron.trim().replace(/\s+/g, ' '),
      timezone: form.timezone,
    }
  }
  return { ...base, event: form.event }
}

/**
 * Patch for an existing routine. Timing is sent only when it changed, because
 * the server re-times a routine whenever `kind` is set.
 */
export function scheduleUpdateFromForm(
  form: ScheduleForm,
  original: AgentSchedule
): Partial<ScheduleInput> {
  const { kind, everySecs, delaySecs, cron, timezone, event, ...rest } =
    scheduleInputFromForm(form)
  const timing = { kind, everySecs, delaySecs, cron, timezone, event }
  const before = scheduleInputFromForm(formFromSchedule(original))
  const unchanged = (Object.keys(timing) as (keyof typeof timing)[]).every(
    key => timing[key] === before[key]
  )
  return unchanged ? rest : { ...rest, ...timing }
}
