import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import {
  afterSuccessCloseOptions,
  CLOSE_SESSION_TOAST_DURATION_MS,
  closeSessionToastOptions,
} from './close-session-toast-action'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const target = {
  worktreeId: 'wt-1',
  worktreePath: '/repo/wt-1',
  sessionId: 's-1',
}

function tapAction(options: { action?: unknown } | undefined) {
  const action = options?.action as { onClick: () => void }
  action.onClick()
}

function makeActions() {
  return {
    close: vi.fn(
      (_target: typeof target, options?: { onSuccess?: () => void }) =>
        options?.onSuccess?.()
    ),
    restore: vi.fn(),
  }
}

describe('closeSessionToastOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sendingSessionIds: {},
      waitingForInputSessionIds: {},
    })
  })

  it('closes the captured session, then Undo restores it', () => {
    const actions = makeActions()
    const options = closeSessionToastOptions(target, actions)

    expect(options.duration).toBe(CLOSE_SESSION_TOAST_DURATION_MS)
    tapAction(options)
    expect(actions.close).toHaveBeenCalledWith(target, expect.anything())

    const [message, undoToast] = vi.mocked(toast.success).mock.calls[0] ?? []
    expect(message).toBe('Session closed')
    tapAction(undoToast)
    expect(actions.restore).toHaveBeenCalledWith(target)
  })

  it('offers nothing without a session', () => {
    expect(closeSessionToastOptions(null, makeActions())).toEqual({})
    expect(
      closeSessionToastOptions(
        { ...target, sessionId: undefined },
        makeActions()
      )
    ).toEqual({})
  })

  it('offers nothing while the session runs or waits for input', () => {
    useChatStore.setState({ sendingSessionIds: { 's-1': true } })
    expect(closeSessionToastOptions(target, makeActions())).toEqual({})

    useChatStore.setState({
      sendingSessionIds: {},
      waitingForInputSessionIds: { 's-1': true },
    })
    expect(closeSessionToastOptions(target, makeActions())).toEqual({})
  })

  it('keeps the session open when it became busy before the tap', () => {
    const actions = makeActions()
    const options = closeSessionToastOptions(target, actions)

    useChatStore.setState({ sendingSessionIds: { 's-1': true } })
    tapAction(options)

    expect(actions.close).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})

describe('afterSuccessCloseOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sendingSessionIds: {},
      waitingForInputSessionIds: {},
    })
  })

  it('closes at once when asked, with Undo and no toast action', () => {
    const actions = makeActions()
    expect(afterSuccessCloseOptions(target, actions, true)).toEqual({})
    expect(actions.close).toHaveBeenCalledWith(target, expect.anything())
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe('Session closed')
  })

  it('only offers the toast action when not asked to close', () => {
    const actions = makeActions()
    const options = afterSuccessCloseOptions(target, actions, false)
    expect(actions.close).not.toHaveBeenCalled()
    expect(options.action).toBeDefined()
  })

  it('reports a busy session and keeps it open', () => {
    useChatStore.setState({ sendingSessionIds: { 's-1': true } })
    const actions = makeActions()
    afterSuccessCloseOptions(target, actions, true)
    expect(actions.close).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})
