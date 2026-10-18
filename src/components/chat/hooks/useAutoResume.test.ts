import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useChatStore } from '@/store/chat-store'
import type { SendMessageArgs } from '@/types/chat'
import { useAutoResume } from './useAutoResume'

const sendMessage = vi.hoisted(() => vi.fn())

vi.mock('@/services/chat', () => ({
  useSendMessage: () => ({ mutate: sendMessage }),
}))

const SESSION = 'session-1'
const args: SendMessageArgs = {
  sessionId: SESSION,
  worktreeId: 'wt-1',
  worktreePath: '/tmp/wt-1',
  message: 'continue the refactor',
  backend: 'claude',
}

describe('useAutoResume', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    sendMessage.mockReset()
    useChatStore.setState({
      autoResume: { [SESSION]: 1_000_000 + 60_000 },
      lastSentArgs: { [SESSION]: args },
      lastSentMessages: {},
      inputDrafts: { [SESSION]: 'continue the refactor' },
      errors: { [SESSION]: "You've hit your session limit" },
      sendingSessionIds: {},
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the reset time, then replays the failed send once', () => {
    renderHook(() => useAutoResume())
    expect(sendMessage).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0]).toEqual(args)
    const state = useChatStore.getState()
    expect(state.autoResume).toEqual({})
    expect(state.errors[SESSION]).toBeNull()
    expect(state.inputDrafts[SESSION]).toBe('')
    // A repeat limit error restores the prompt into the input from here.
    expect(state.lastSentMessages[SESSION]).toBe('continue the refactor')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not replay while the session is still sending', () => {
    useChatStore.setState({ sendingSessionIds: { [SESSION]: true } })
    renderHook(() => useAutoResume())

    act(() => {
      vi.advanceTimersByTime(120_000)
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(useChatStore.getState().autoResume).toEqual({
      [SESSION]: 1_060_000,
    })
  })

  it('does nothing after the user cancels', () => {
    renderHook(() => useAutoResume())
    act(() => {
      useChatStore.getState().disarmAutoResume(SESSION)
      vi.advanceTimersByTime(120_000)
    })

    expect(sendMessage).not.toHaveBeenCalled()
  })
})
