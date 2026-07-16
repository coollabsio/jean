import { describe, expect, it } from 'vitest'
import { setServerPlatform } from '@/lib/platform'
import { getTerminalOptions } from './preferences'

describe('server platform option filtering', () => {
  it('uses the Jean server platform for terminal options', () => {
    setServerPlatform('linux')
    expect(getTerminalOptions().map(option => option.value)).toEqual([
      'terminal',
      'ghostty',
      'kitty',
    ])

    setServerPlatform('mac')
    expect(getTerminalOptions().map(option => option.value)).toEqual([
      'terminal',
      'warp',
      'ghostty',
      'kitty',
      'iterm2',
    ])

    setServerPlatform('windows')
    expect(getTerminalOptions().map(option => option.value)).toEqual([
      'warp',
      'powershell',
      'windows-terminal',
    ])
  })
})
