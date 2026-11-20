import { describe, expect, it } from 'vitest'
import { isCliUpdateCompleteOutput } from './cli-update-output'

describe('isCliUpdateCompleteOutput', () => {
  it('recognizes common up-to-date messages', () => {
    expect(isCliUpdateCompleteOutput('Already up to date.')).toBe(true)
    expect(isCliUpdateCompleteOutput('CLI is up-to-date')).toBe(true)
    expect(isCliUpdateCompleteOutput('You are running the latest version')).toBe(
      true
    )
    expect(isCliUpdateCompleteOutput('No updates available.')).toBe(true)
    expect(isCliUpdateCompleteOutput('Nothing to install')).toBe(true)
  })

  it('ignores in-progress and negative messages', () => {
    expect(isCliUpdateCompleteOutput('Checking for updates…')).toBe(false)
    expect(isCliUpdateCompleteOutput('Downloading update…')).toBe(false)
    expect(isCliUpdateCompleteOutput('Your CLI is not up to date')).toBe(false)
    expect(isCliUpdateCompleteOutput('')).toBe(false)
  })
})
