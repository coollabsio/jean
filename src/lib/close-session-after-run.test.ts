import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { closeSessionAfterRun } from './close-session-after-run'

const handlers = vi.hoisted(
  () => new Map<string, Set<(event: { payload: unknown }) => void>>()
)

vi.mock('@/lib/transport', () => ({
  listen: async (
    event: string,
    handler: (event: { payload: unknown }) => void
  ) => {
    const set = handlers.get(event) ?? new Set()
    set.add(handler)
    handlers.set(event, set)
    return () => set.delete(handler)
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const target = { worktreeId: 'wt-1', worktreePath: '/wt', sessionId: 's-1' }

function emit(event: string, payload: Record<string, unknown>) {
  for (const handler of handlers.get(event) ?? []) handler({ payload })
}

function setup() {
  const actions = { close: vi.fn(), restore: vi.fn() }
  closeSessionAfterRun(target, actions)
  return actions
}

describe('closeSessionAfterRun', () => {
  beforeEach(() => {
    handlers.clear()
    useChatStore.setState({
      sendingSessionIds: { 's-1': true },
      waitingForInputSessionIds: {},
      messageQueues: {},
    })
  })

  it('closes once the run has ended and its state cleared', () => {
    const actions = setup()

    emit('chat:done', { session_id: 's-1' })
    expect(actions.close).not.toHaveBeenCalled()

    useChatStore.setState({ sendingSessionIds: {} })
    expect(actions.close).toHaveBeenCalledWith(target, expect.anything())

    // A later run of the same session does not close it again.
    useChatStore.setState({ sendingSessionIds: { 's-1': true } })
    useChatStore.setState({ sendingSessionIds: {} })
    emit('chat:done', { session_id: 's-1' })
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it('ignores other sessions', () => {
    const actions = setup()
    useChatStore.setState({ sendingSessionIds: {} })
    emit('chat:done', { session_id: 'other' })
    expect(actions.close).not.toHaveBeenCalled()
  })

  it.each([
    ['an error', () => emit('chat:error', { session_id: 's-1' })],
    ['a cancel', () => emit('chat:cancelled', { session_id: 's-1' })],
  ])('keeps the session open after %s', (_name, end) => {
    const actions = setup()
    end()
    useChatStore.setState({ sendingSessionIds: {} })
    emit('chat:done', { session_id: 's-1' })
    expect(actions.close).not.toHaveBeenCalled()
  })

  it('keeps the session open when a plan waits for approval', () => {
    const actions = setup()
    useChatStore.setState({ sendingSessionIds: {} })
    emit('chat:done', { session_id: 's-1', waiting_for_plan: true })
    expect(actions.close).not.toHaveBeenCalled()
  })

  it('keeps the session open while queued messages remain', () => {
    const actions = setup()
    useChatStore.setState({
      sendingSessionIds: {},
      messageQueues: {
        's-1': [{ id: 'q' }] as never,
      },
    })
    emit('chat:done', { session_id: 's-1' })
    expect(actions.close).not.toHaveBeenCalled()
  })
})
