/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalStore } from '@/store/terminal-store'
import {
  closeChatTerminal,
  isChatTerminalOpen,
  openChatTerminal,
} from './terminal-gesture'

describe('terminal-gesture helpers', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: {},
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      modalTerminalOpen: {},
    })
  })

  it('opens and closes modal terminal', () => {
    expect(isChatTerminalOpen('wt-1', 'modal')).toBe(false)
    openChatTerminal('wt-1', 'modal')
    expect(isChatTerminalOpen('wt-1', 'modal')).toBe(true)
    closeChatTerminal('wt-1', 'modal')
    expect(isChatTerminalOpen('wt-1', 'modal')).toBe(false)
  })

  it('opens panel terminal (creates instance) and closes it', () => {
    expect(isChatTerminalOpen('wt-1', 'panel')).toBe(false)
    openChatTerminal('wt-1', 'panel')
    expect(isChatTerminalOpen('wt-1', 'panel')).toBe(true)
    expect(useTerminalStore.getState().terminals['wt-1']?.length).toBe(1)
    closeChatTerminal('wt-1', 'panel')
    expect(isChatTerminalOpen('wt-1', 'panel')).toBe(false)
    expect(useTerminalStore.getState().terminalVisible).toBe(false)
  })

  it('reopens existing panel terminal without duplicating', () => {
    openChatTerminal('wt-1', 'panel')
    closeChatTerminal('wt-1', 'panel')
    openChatTerminal('wt-1', 'panel')
    expect(useTerminalStore.getState().terminals['wt-1']?.length).toBe(1)
    expect(isChatTerminalOpen('wt-1', 'panel')).toBe(true)
  })
})
