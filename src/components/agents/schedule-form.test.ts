import { describe, expect, it } from 'vitest'
import type { AgentSchedule } from '@/services/agents'
import {
  cronMinutes,
  emptyScheduleForm,
  formatInterval,
  formatScheduleWhen,
  formFromSchedule,
  scheduleInputFromForm,
  scheduleUpdateFromForm,
  timezoneOptions,
  validateCronExpression,
  validateScheduleForm,
} from './schedule-form'

function schedule(overrides: Partial<AgentSchedule>): AgentSchedule {
  return {
    id: 1,
    agentId: 'jean',
    name: 'Brief',
    prompt: 'Summarize',
    everySecs: null,
    nextRunAt: 1_700_000_000,
    lastRunAt: null,
    cron: null,
    timezone: null,
    event: null,
    paused: false,
    ...overrides,
  }
}

describe('formatInterval', () => {
  it('uses the largest whole unit', () => {
    expect(formatInterval(30 * 60)).toBe('every 30m')
    expect(formatInterval(2 * 3600)).toBe('every 2h')
    expect(formatInterval(86_400)).toBe('every 1d')
    expect(formatInterval(90 * 60)).toBe('every 90m')
  })
})

describe('validateCronExpression', () => {
  it('accepts five-field expressions at least five minutes apart', () => {
    expect(validateCronExpression('0 9 * * 1-5')).toBeNull()
    expect(validateCronExpression('*/5 * * * *')).toBeNull()
    expect(validateCronExpression('0,5,10 * * * *')).toBeNull()
    expect(cronMinutes('*/15')).toEqual([0, 15, 30, 45])
    expect(cronMinutes('0/15')).toEqual([0, 15, 30, 45])
    expect(cronMinutes('50/5')).toEqual([50, 55])
  })

  it('rejects malformed fields and tight spacing', () => {
    expect(validateCronExpression('* * *')).toMatch(/5 fields/)
    expect(validateCronExpression('* * * * *')).toMatch(/5 minutes/)
    expect(validateCronExpression('*/4 * * * *')).toMatch(/5 minutes/)
    expect(validateCronExpression('58,1 * * * *')).toMatch(/5 minutes/)
    expect(validateCronExpression('60 * * * *')).toMatch(/Minute field/)
  })
})

describe('validateScheduleForm', () => {
  it('checks each kind', () => {
    const cron = {
      ...emptyScheduleForm('UTC'),
      name: 'Standup',
      prompt: 'Summarize overnight changes',
    }
    expect(validateScheduleForm(cron)).toBeNull()
    expect(validateScheduleForm({ ...cron, cron: '*/1 * * * *' })).toMatch(
      /5 minutes/
    )
    expect(
      validateScheduleForm({
        ...cron,
        kind: 'interval',
        everyAmount: '4',
        everyUnit: 'minutes',
      })
    ).toMatch(/5 minutes/)
    expect(
      validateScheduleForm({ ...cron, kind: 'once', delayMinutes: '0' })
    ).toMatch(/Delay/)
    expect(validateScheduleForm({ ...cron, kind: 'event' })).toBeNull()
    expect(validateScheduleForm({ ...cron, name: '  ' })).toMatch(/Name/)
  })
})

describe('formatScheduleWhen', () => {
  const now = 1_700_000_000_000

  it('describes cron, events, intervals, and one-shots', () => {
    expect(
      formatScheduleWhen(
        schedule({
          cron: '0 9 * * 1-5',
          timezone: 'UTC',
          nextRunAt: now / 1000 + 3600,
        }),
        now
      )
    ).toBe('0 9 * * 1-5 UTC, next in 1h')
    expect(
      formatScheduleWhen(
        schedule({ event: 'pr_merged', lastRunAt: now / 1000 - 120 }),
        now
      )
    ).toBe('on Pull request merged, last 2m ago')
    expect(
      formatScheduleWhen(
        schedule({ everySecs: 3600, nextRunAt: now / 1000 + 60 }),
        now
      )
    ).toBe('every 1h, next in 1m')
    expect(formatScheduleWhen(schedule({ paused: true }), now)).toBe(
      'once, paused'
    )
  })
})

describe('schedule input', () => {
  it('keeps the browser timezone in the list and maps a form to command fields', () => {
    expect(timezoneOptions('Europe/Helsinki')[0]).toBe('Europe/Helsinki')
    expect(timezoneOptions('UTC')).toContain('UTC')
    const input = scheduleInputFromForm({
      ...emptyScheduleForm('UTC'),
      name: ' Standup ',
      prompt: ' Say hello ',
      kind: 'interval',
      everyAmount: '2',
      everyUnit: 'hours',
    })
    expect(input).toMatchObject({
      name: 'Standup',
      prompt: 'Say hello',
      kind: 'interval',
      everySecs: 7200,
    })
    const stored = formFromSchedule(
      schedule({
        everySecs: 7200,
        cron: null,
        name: 'Standup',
        prompt: 'Say hello',
      })
    )
    expect(stored.kind).toBe('interval')
    expect(stored.everyAmount).toBe('2')
    expect(stored.everyUnit).toBe('hours')
  })
})

describe('scheduleUpdateFromForm', () => {
  it('omits timing when only the name changes, so the routine keeps its time', () => {
    const once = schedule({ name: 'Brief', prompt: 'Summarize' })
    const renamed = { ...formFromSchedule(once), name: 'Morning brief' }
    expect(scheduleUpdateFromForm(renamed, once)).toEqual({
      name: 'Morning brief',
      prompt: 'Summarize',
      paused: false,
    })
  })

  it('sends the new timing when it changed', () => {
    const cron = schedule({ cron: '0 9 * * 1-5', timezone: 'UTC' })
    const moved = { ...formFromSchedule(cron), cron: '0 10 * * 1-5' }
    expect(scheduleUpdateFromForm(moved, cron)).toEqual({
      name: 'Brief',
      prompt: 'Summarize',
      paused: false,
      kind: 'cron',
      everySecs: undefined,
      delaySecs: undefined,
      cron: '0 10 * * 1-5',
      timezone: 'UTC',
      event: undefined,
    })
  })
})
