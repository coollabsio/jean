import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { MobileToolbarMenu } from './MobileToolbarMenu'

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

describe('MobileToolbarMenu', () => {
  it('renders verb sections only and excludes settings/contexts', async () => {
    const user = userEvent.setup()

    render(
      <MobileToolbarMenu
        isDisabled={false}
        hasOpenPr={false}
        hasIssueContexts={false}
        hasPrContexts={false}
        onSaveContext={vi.fn()}
        onLoadContext={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
        onRevertLastCommit={vi.fn()}
        onOpenPr={vi.fn()}
        onReview={vi.fn()}
        onMerge={vi.fn()}
        onMergePr={vi.fn()}
        handlePullClick={vi.fn()}
        handlePushClick={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /more actions/i }))

    expect(screen.getByText('Save Context')).toBeInTheDocument()
    expect(screen.getByText('Commit & Push')).toBeInTheDocument()
    expect(screen.getByText('Pull')).toBeInTheDocument()
    expect(screen.getByText('Push')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(screen.getByText('Merge to Base')).toBeInTheDocument()

    expect(screen.queryByText('Backend / Model')).not.toBeInTheDocument()
    expect(screen.queryByText('MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('Provider')).not.toBeInTheDocument()
    expect(screen.queryByText('Uncommitted')).not.toBeInTheDocument()
    expect(screen.queryByText('Branch diff')).not.toBeInTheDocument()
  })

  it('disables investigate issue and PR when no contexts are loaded', async () => {
    const user = userEvent.setup()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    render(
      <MobileToolbarMenu
        isDisabled={false}
        hasOpenPr={false}
        hasIssueContexts={false}
        hasPrContexts={false}
        onSaveContext={vi.fn()}
        onLoadContext={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
        onRevertLastCommit={vi.fn()}
        onOpenPr={vi.fn()}
        onReview={vi.fn()}
        onMerge={vi.fn()}
        onMergePr={vi.fn()}
        handlePullClick={vi.fn()}
        handlePushClick={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /more actions/i }))

    const issueItem = screen.getByText('Issue').closest('[role="menuitem"]')
    const prItem = screen.getByText('PR').closest('[role="menuitem"]')

    expect(issueItem).toHaveAttribute('aria-disabled', 'true')
    expect(prItem).toHaveAttribute('aria-disabled', 'true')

    if (issueItem) await user.click(issueItem)
    if (prItem) await user.click(prItem)

    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'magic-command' })
    )

    dispatchSpy.mockRestore()
  })

  it('enables investigate issue and PR when contexts are loaded', async () => {
    const user = userEvent.setup()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    render(
      <MobileToolbarMenu
        isDisabled={false}
        hasOpenPr={false}
        hasIssueContexts={true}
        hasPrContexts={true}
        onSaveContext={vi.fn()}
        onLoadContext={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
        onRevertLastCommit={vi.fn()}
        onOpenPr={vi.fn()}
        onReview={vi.fn()}
        onMerge={vi.fn()}
        onMergePr={vi.fn()}
        handlePullClick={vi.fn()}
        handlePushClick={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /more actions/i }))

    const issueItem = screen.getByText('Issue').closest('[role="menuitem"]')
    expect(issueItem).not.toHaveAttribute('aria-disabled', 'true')

    if (issueItem) await user.click(issueItem)

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'magic-command',
        detail: { command: 'investigate', type: 'issue' },
      })
    )

    dispatchSpy.mockRestore()
  })

  it('shows fork session in the context section and dispatches the magic command', async () => {
    const user = userEvent.setup()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    render(
      <MobileToolbarMenu
        isDisabled={false}
        hasOpenPr={false}
        hasIssueContexts={false}
        hasPrContexts={false}
        onSaveContext={vi.fn()}
        onLoadContext={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
        onRevertLastCommit={vi.fn()}
        onOpenPr={vi.fn()}
        onReview={vi.fn()}
        onMerge={vi.fn()}
        onMergePr={vi.fn()}
        handlePullClick={vi.fn()}
        handlePushClick={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /more actions/i }))
    await user.click(screen.getByText('Fork Session'))

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'magic-command',
        detail: { command: 'fork-session' },
      })
    )

    dispatchSpy.mockRestore()
  })

  it('shows revert commit in the commit section and invokes its handler', async () => {
    const user = userEvent.setup()
    const onRevertLastCommit = vi.fn()

    render(
      <MobileToolbarMenu
        isDisabled={false}
        hasOpenPr={false}
        hasIssueContexts={false}
        hasPrContexts={false}
        onSaveContext={vi.fn()}
        onLoadContext={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
        onRevertLastCommit={onRevertLastCommit}
        onOpenPr={vi.fn()}
        onReview={vi.fn()}
        onMerge={vi.fn()}
        onMergePr={vi.fn()}
        handlePullClick={vi.fn()}
        handlePushClick={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /more actions/i }))

    expect(screen.getByText('Revert Commit')).toBeInTheDocument()
    await user.click(screen.getByText('Revert Commit'))

    expect(onRevertLastCommit).toHaveBeenCalledTimes(1)
  })

  it('does not expose the desktop Magic modal from the mobile actions menu', async () => {
    const user = userEvent.setup()
    const onOpenMagicModal = vi.fn()

    render(
      <MobileToolbarMenu
        isDisabled={false}
        hasOpenPr={false}
        hasIssueContexts={false}
        hasPrContexts={false}
        onSaveContext={vi.fn()}
        onLoadContext={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
        onRevertLastCommit={vi.fn()}
        onOpenPr={vi.fn()}
        onReview={vi.fn()}
        onMerge={vi.fn()}
        onMergePr={vi.fn()}
        handlePullClick={vi.fn()}
        handlePushClick={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /more actions/i }))

    expect(screen.queryByText('Magic')).not.toBeInTheDocument()
    expect(onOpenMagicModal).not.toHaveBeenCalled()
  })
})
