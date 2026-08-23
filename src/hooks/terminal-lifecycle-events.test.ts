import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { chatQueryKeys } from '@/services/chat'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import type { Session } from '@/types/chat'

const { mockPlayWaitingSound, mockNotify } = vi.hoisted(() => ({
  mockPlayWaitingSound: vi.fn(),
  mockNotify: vi.fn(),
}))

vi.mock('@/lib/sounds', () => ({
  playWaitingSound: mockPlayWaitingSound,
  playNotificationSound: vi.fn(),
  preloadAllSounds: vi.fn(),
}))

vi.mock('@/lib/session-notifications', () => ({
  notifySessionNeedsAttention: mockNotify,
  notifyIfBackground: vi.fn(),
  isSessionCurrentlyViewed: () => false,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => undefined),
  listenLocal: vi.fn().mockResolvedValue(() => undefined),
}))

const { applyTerminalLifecycleEvent } = await import(
  './useMainWindowEventListeners'
)

const SESSION_ID = 'session-1'

function setPreferences(
  queryClient: QueryClient,
  prefs: Partial<AppPreferences>
): void {
  queryClient.setQueryData(preferencesQueryKeys.preferences(), prefs)
}

describe('applyTerminalLifecycleEvent', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    mockPlayWaitingSound.mockClear()
    mockNotify.mockClear()
    queryClient = new QueryClient()
    useChatStore.setState({
      sendingSessionIds: {},
      waitingForInputSessionIds: {},
    })
  })

  it('marks the session running on working', () => {
    useChatStore.getState().setWaitingForInput(SESSION_ID, true)

    applyTerminalLifecycleEvent(
      'working',
      { sessionId: SESSION_ID },
      queryClient
    )

    const state = useChatStore.getState()
    expect(state.sendingSessionIds[SESSION_ID]).toBe(true)
    expect(state.waitingForInputSessionIds[SESSION_ID]).toBeFalsy()
    expect(mockPlayWaitingSound).not.toHaveBeenCalled()
  })

  it('marks the session waiting, plays the sound and notifies on attention', () => {
    setPreferences(queryClient, { waiting_sound: 'jobsdone' })
    queryClient.setQueryData<Session>(chatQueryKeys.session(SESSION_ID), {
      name: 'My session',
    } as Session)
    useChatStore.getState().addSendingSession(SESSION_ID)

    applyTerminalLifecycleEvent(
      'attention',
      { sessionId: SESSION_ID },
      queryClient
    )

    const state = useChatStore.getState()
    expect(state.sendingSessionIds[SESSION_ID]).toBeFalsy()
    expect(state.waitingForInputSessionIds[SESSION_ID]).toBe(true)
    expect(mockPlayWaitingSound).toHaveBeenCalledWith({
      waiting_sound: 'jobsdone',
    })
    expect(mockNotify).toHaveBeenCalledWith(
      SESSION_ID,
      'Needs your input',
      'My session'
    )
  })

  it('still plays the sound when desktop notifications are disabled', () => {
    setPreferences(queryClient, { desktop_notifications_enabled: false })

    applyTerminalLifecycleEvent(
      'attention',
      { sessionId: SESSION_ID },
      queryClient
    )

    expect(mockPlayWaitingSound).toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('clears both running and waiting on idle', () => {
    useChatStore.getState().addSendingSession(SESSION_ID)
    useChatStore.getState().setWaitingForInput(SESSION_ID, true)

    applyTerminalLifecycleEvent('idle', { sessionId: SESSION_ID }, queryClient)

    const state = useChatStore.getState()
    expect(state.sendingSessionIds[SESSION_ID]).toBeFalsy()
    expect(state.waitingForInputSessionIds[SESSION_ID]).toBeFalsy()
    expect(mockPlayWaitingSound).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('ignores events without a session id', () => {
    applyTerminalLifecycleEvent('attention', {}, queryClient)
    applyTerminalLifecycleEvent('attention', undefined, queryClient)

    expect(mockPlayWaitingSound).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })
})
