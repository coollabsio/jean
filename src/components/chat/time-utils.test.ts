import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  formatLocalTime,
  getAssistantDurationMs,
} from './time-utils'
import type { ChatMessage } from '@/types/chat'

describe('formatDuration', () => {
  it('formats sub-minute durations as seconds only', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(23_999)).toBe('23s')
  })

  it('formats minute boundaries as mm:ss', () => {
    expect(formatDuration(60_000)).toBe('01:00')
    expect(formatDuration(145_000)).toBe('02:25')
  })
})

describe('getAssistantDurationMs', () => {
  const messages: ChatMessage[] = [
    {
      id: 'user-1',
      session_id: 'session-1',
      role: 'user',
      content: 'Prompt',
      timestamp: 100,
      tool_calls: [],
      content_blocks: [],
    },
    {
      id: 'assistant-1',
      session_id: 'session-1',
      role: 'assistant',
      content: 'Reply',
      timestamp: 123,
      tool_calls: [],
      content_blocks: [],
    },
  ]

  it('prefers stored duration for the final assistant message', () => {
    expect(getAssistantDurationMs(messages, 1, 145_000)).toBe(145_000)
  })

  it('falls back to user-to-assistant timestamp delta', () => {
    expect(getAssistantDurationMs(messages, 1, null)).toBe(23_000)
  })

  it('does not produce duration for user messages', () => {
    expect(getAssistantDurationMs(messages, 0, 145_000)).toBeNull()
  })
})

describe('formatLocalTime', () => {
  const hourMinute: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  }

  it('converts unix seconds to milliseconds before formatting', () => {
    const unixSeconds = 1_700_000_000
    const fromSeconds = new Date(unixSeconds * 1000).toLocaleTimeString(
      [],
      hourMinute
    )
    const fromRawMilliseconds = new Date(unixSeconds).toLocaleTimeString(
      [],
      hourMinute
    )

    expect(formatLocalTime(unixSeconds)).toBe(fromSeconds)
    expect(fromSeconds).not.toBe(fromRawMilliseconds)
  })

  it('formats a locale hour:minute and omits seconds', () => {
    const unixSeconds = Date.UTC(2026, 3, 25, 12, 34, 56) / 1000
    const hourAndMinute = new Date(unixSeconds * 1000).toLocaleTimeString(
      [],
      hourMinute
    )
    const withSeconds = new Date(unixSeconds * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    expect(formatLocalTime(unixSeconds)).toBe(hourAndMinute)
    expect(withSeconds).not.toBe(hourAndMinute)
  })

  it('renders distinct times for different timestamps', () => {
    const morning = Date.UTC(2026, 3, 25, 9, 0, 0) / 1000
    const evening = Date.UTC(2026, 3, 25, 21, 0, 0) / 1000

    expect(formatLocalTime(morning)).not.toBe(formatLocalTime(evening))
  })
})
