/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ExitPlanModeButton } from './ExitPlanModeButton'
import type { ToolCall } from '@/types/chat'
import type * as DropdownMenuModule from '@/components/ui/dropdown-menu'

class ResizeObserverMock {
  observe() {
    return undefined
  }
  unobserve() {
    return undefined
  }
  disconnect() {
    return undefined
  }
}

globalThis.ResizeObserver =
  ResizeObserverMock as unknown as typeof ResizeObserver

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['claude', 'codex'],
    isLoading: false,
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: [] }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({ data: [] }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      yolo_backend: 'codex',
      yolo_model: 'gpt-5.5',
      selected_codex_model: 'gpt-5.5',
      default_backend: 'claude',
    },
  }),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: (
    selector: (state: { selectedBackends: Record<string, string> }) => unknown
  ) => selector({ selectedBackends: {} }),
}))

vi.mock('./ApprovalModelSubmenu', async () => {
  const { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } =
    await vi.importActual<typeof DropdownMenuModule>(
      '@/components/ui/dropdown-menu'
    )

  return {
    ApprovalActionMenu: ({
      onApprove,
      onApproveYolo,
      onClearContextApproval,
      onClearContextApprove,
      onClearContextBuildApproval,
      onClearContextBuildApprove,
      onWorktreeBuildApproval,
      onWorktreeBuildApprove,
      onWorktreeYoloApproval,
      onWorktreeYoloApprove,
    }: {
      onApprove?: () => void
      onApproveYolo?: () => void
      onClearContextApproval?: (override?: {
        backend: string
        model: string
      }) => void
      onClearContextApprove?: (override?: {
        backend: string
        model: string
      }) => void
      onClearContextBuildApproval?: (override?: {
        backend: string
        model: string
      }) => void
      onClearContextBuildApprove?: (override?: {
        backend: string
        model: string
      }) => void
      onWorktreeBuildApproval?: (override?: {
        backend: string
        model: string
      }) => void
      onWorktreeBuildApprove?: (override?: {
        backend: string
        model: string
      }) => void
      onWorktreeYoloApproval?: (override?: {
        backend: string
        model: string
      }) => void
      onWorktreeYoloApprove?: (override?: {
        backend: string
        model: string
      }) => void
    }) => (
      <>
        {(onApproveYolo ||
          onClearContextApprove ||
          onClearContextApproval ||
          onWorktreeYoloApprove ||
          onWorktreeYoloApproval) && (
          <>
            {onApproveYolo && (
              <DropdownMenuItem onClick={onApproveYolo}>
                Current Session
              </DropdownMenuItem>
            )}
            {(onClearContextApprove ?? onClearContextApproval) && (
              <>
                <DropdownMenuLabel>New Session</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() =>
                    (onClearContextApprove ?? onClearContextApproval)?.()
                  }
                >
                  <span>Codex · GPT 5.5</span>
                  <span>(use default)</span>
                </DropdownMenuItem>
              </>
            )}
            {(onWorktreeYoloApprove ?? onWorktreeYoloApproval) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>New Worktree</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() =>
                    (onWorktreeYoloApprove ?? onWorktreeYoloApproval)?.()
                  }
                >
                  <span>Codex · GPT 5.5</span>
                  <span>(use default)</span>
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
        {(onApprove ||
          onClearContextBuildApprove ||
          onClearContextBuildApproval ||
          onWorktreeBuildApprove ||
          onWorktreeBuildApproval) && (
          <>
            {onApprove && (
              <DropdownMenuItem onClick={onApprove}>
                Current Session
              </DropdownMenuItem>
            )}
            {(onClearContextBuildApprove ?? onClearContextBuildApproval) && (
              <>
                <DropdownMenuLabel>New Session</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() =>
                    (
                      onClearContextBuildApprove ?? onClearContextBuildApproval
                    )?.()
                  }
                >
                  <span>Codex · GPT 5.5</span>
                  <span>(use default)</span>
                </DropdownMenuItem>
              </>
            )}
            {(onWorktreeBuildApprove ?? onWorktreeBuildApproval) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>New Worktree</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() =>
                    (onWorktreeBuildApprove ?? onWorktreeBuildApproval)?.()
                  }
                >
                  <span>Codex · GPT 5.5</span>
                  <span>(use default)</span>
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </>
    ),
  }
})

const planToolCalls: ToolCall[] = [
  {
    id: 'plan-1',
    name: 'CodexPlan',
    input: { plan_preview: 'Plan' },
  },
]

function getMenuItem(name: RegExp, index: number) {
  const item = screen.getAllByRole('menuitem', { name })[index]
  expect(item).toBeDefined()
  return item as HTMLElement
}

function getButton(name: string, index: number) {
  const button = screen.getAllByRole('button', { name })[index]
  expect(button).toBeDefined()
  return button as HTMLElement
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('ExitPlanModeButton', () => {
  it('keeps YOLO as the primary left button and Approve as the secondary right button', async () => {
    const user = userEvent.setup()
    const onPlanApproval = vi.fn()
    const onPlanApprovalYolo = vi.fn()
    const onClearContextApproval = vi.fn()
    const onClearContextBuildApproval = vi.fn()
    const onWorktreeBuildApproval = vi.fn()
    const onWorktreeYoloApproval = vi.fn()

    render(
      <ExitPlanModeButton
        toolCalls={planToolCalls}
        isApproved={false}
        onPlanApproval={onPlanApproval}
        onPlanApprovalYolo={onPlanApprovalYolo}
        onClearContextApproval={onClearContextApproval}
        onClearContextBuildApproval={onClearContextBuildApproval}
        onWorktreeBuildApproval={onWorktreeBuildApproval}
        onWorktreeYoloApproval={onWorktreeYoloApproval}
        sessionId="session-1"
      />
    )

    const yoloButton = screen.getByRole('button', { name: 'Full access' })
    const approveButton = screen.getByRole('button', { name: 'Approve' })
    expect(yoloButton).toBeInTheDocument()
    expect(approveButton).toBeInTheDocument()
    expect(
      yoloButton.compareDocumentPosition(approveButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(screen.getAllByRole('button', { name: '' })).toHaveLength(2)

    await user.click(getButton('', 0))

    expect(screen.queryByText('Build')).toBeNull()
    expect(screen.getAllByText('New Session')).toHaveLength(1)
    expect(screen.getAllByText('New Worktree')).toHaveLength(1)

    await user.click(getMenuItem(/\(use default\)/i, 0))
    expect(onClearContextApproval).toHaveBeenCalledWith()

    await user.click(getButton('', 0))
    await user.click(getMenuItem(/\(use default\)/i, 1))
    expect(onWorktreeYoloApproval).toHaveBeenCalledWith()

    await user.click(getButton('', 1))
    expect(screen.queryByText('Build')).toBeNull()
    expect(screen.queryByText('New Session (YOLO)')).toBeNull()
    expect(screen.queryByText('New Worktree (YOLO)')).toBeNull()

    await user.click(getMenuItem(/\(use default\)/i, 0))
    expect(onClearContextBuildApproval).toHaveBeenCalledWith()

    await user.click(getButton('', 1))
    await user.click(getMenuItem(/\(use default\)/i, 1))
    expect(onWorktreeBuildApproval).toHaveBeenCalledWith()
  })
})
