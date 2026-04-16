import { describe, expect, it } from 'vitest'
import { getDisplayPath } from './platform'

describe('getDisplayPath', () => {
  it('returns the original path when WSL mode is disabled', () => {
    expect(
      getDisplayPath('\\\\wsl.localhost\\Ubuntu\\home\\user\\project', false)
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\project')
  })

  it('strips WSL UNC prefixes for display when WSL mode is enabled', () => {
    expect(
      getDisplayPath('\\\\wsl.localhost\\Ubuntu\\home\\user\\project', true)
    ).toBe('/home/user/project')
  })

  it('leaves non-WSL paths unchanged when WSL mode is enabled', () => {
    expect(getDisplayPath('C:\\Users\\user\\project', true)).toBe(
      'C:\\Users\\user\\project'
    )
  })
})
