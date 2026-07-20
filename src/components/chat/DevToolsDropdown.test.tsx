import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { useChatStore } from '@/store/chat-store'
import { DevToolsDropdown } from './DevToolsDropdown'

const { invokeMock, toastSuccessMock, sendMessageMutateMock } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(() => Promise.resolve(undefined)),
    toastSuccessMock: vi.fn(),
    sendMessageMutateMock: vi.fn(),
  })
)

vi.mock('@/lib/transport', () => ({
  invoke: invokeMock,
}))

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
  },
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      selected_codex_model: 'gpt-5.4',
      default_codex_reasoning_effort: 'high',
      default_grok_reasoning_effort: 'high',
      chrome_enabled: false,
      ai_language: 'English',
    },
  }),
}))

vi.mock('@/services/chat', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/chat')>('@/services/chat') // eslint-disable-line @typescript-eslint/consistent-type-imports

  return {
    ...actual,
    useSendMessage: () => ({
      mutate: sendMessageMutateMock,
    }),
  }
})

describe('DevToolsDropdown', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    toastSuccessMock.mockClear()
    sendMessageMutateMock.mockClear()
    useChatStore.setState({
      waitingForInputSessionIds: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      pendingCodexUserInputRequests: {},
      inputDrafts: {},
      executionModes: {},
      effortLevels: {},
      selectedBackends: {},
      selectedModels: {},
    })
  })

  it('injects the selected Codex dev flow from the dropdown menu', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <DevToolsDropdown
        sessionId="session-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree"
      />
    )

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(2)

    await user.click(buttons[1] as HTMLButtonElement)

    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByText('Options + other'))

    const state = useChatStore.getState()
    const pending = state.getPendingCodexUserInputRequests('session-1')

    expect(pending).toHaveLength(1)
    expect(pending[0]?.item_id).toBe('dev-tool-request-user-input-other')
    expect(state.isWaitingForInput('session-1')).toBe(true)
    expect(state.activeToolCalls['session-1']).toEqual([
      expect.objectContaining({
        id: 'dev-tool-request-user-input-other',
        name: 'AskUserQuestion',
      }),
    ])
    expect(state.streamingContentBlocks['session-1']).toEqual([
      { type: 'tool_use', tool_call_id: 'dev-tool-request-user-input-other' },
    ])
    expect(invokeMock).toHaveBeenCalledWith('update_session_state', {
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree',
      sessionId: 'session-1',
      waitingForInput: true,
      waitingForInputType: 'question',
      pendingCodexUserInputRequests: expect.arrayContaining([
        expect.objectContaining({
          item_id: 'dev-tool-request-user-input-other',
        }),
      ]),
    })
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Injected Codex dev flow: Options + other'
    )
  })
})
