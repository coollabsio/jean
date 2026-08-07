import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { appearanceCommands } from './appearance-commands'

describe('Zen mode appearance command', () => {
  beforeEach(() => {
    useUIStore.setState({ zenMode: false })
  })

  it('stays available in the command palette and toggles zen mode', () => {
    const command = appearanceCommands.find(cmd => cmd.id === 'zen-mode.toggle')

    expect(command).toBeDefined()
    expect(command?.isAvailable).toBeUndefined()

    command?.execute({} as never)
    expect(useUIStore.getState().zenMode).toBe(true)
  })

  it('only exposes one zen mode command', () => {
    expect(
      appearanceCommands.filter(command => command.id.includes('zen-mode'))
    ).toHaveLength(1)
  })
})
