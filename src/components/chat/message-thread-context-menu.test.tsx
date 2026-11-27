import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import {
  getTrimmedSelectionText,
  MessageThreadContextMenu,
  suppressDefaultContextMenu,
} from './message-thread-context-menu'
import { useUIStore } from '@/store/ui-store'
import type * as ProjectsModule from '@/services/projects'
import type * as PlatformModule from '@/lib/platform'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  downloadLocalFile: vi.fn(),
  openLocalFile: vi.fn(),
  createWorktree: vi.fn(),
  fetchIssueContext: vi.fn(),
  fetchPullRequestContext: vi.fn(),
  investigateInNewSession: vi.fn(),
  openExternal: vi.fn(() => Promise.resolve()),
}))

vi.mock('./context-mention-investigation', () => ({
  investigateInNewSession: mocks.investigateInNewSession,
}))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  openExternal: mocks.openExternal,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { magic_prompts: { investigate_issue: 'I {issueRefs}' } },
  }),
}))

vi.mock('@/lib/local-file', () => ({
  downloadLocalFile: mocks.downloadLocalFile,
  openLocalFile: mocks.openLocalFile,
  resolveWorktreeFilePath: (path: string) => `/repo/${path}`,
  getCurrentWorktree: () => ({ id: 'wt-1', path: '/repo' }),
}))

vi.mock('@/services/projects', async importOriginal => ({
  githubRepoFromUrl: (await importOriginal<typeof ProjectsModule>())
    .githubRepoFromUrl,
  useWorktree: () => ({
    data: { id: 'wt-1', path: '/repo', project_id: 'proj-1' },
  }),
  useGitHubRemotes: () => ({
    data: [
      { name: 'origin', url: 'https://github.com/acme/app' },
      { name: 'fork', url: 'https://github.com/me/app.git' },
    ],
  }),
  useCreateWorktree: () => ({ mutateAsync: mocks.createWorktree }),
}))

vi.mock('@/services/github', () => ({
  fetchIssueContext: mocks.fetchIssueContext,
  fetchPullRequestContext: mocks.fetchPullRequestContext,
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}))

describe('getTrimmedSelectionText', () => {
  it('returns trimmed window selection text', () => {
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '  hello world  ',
      }) as Selection

    expect(getTrimmedSelectionText()).toBe('hello world')

    window.getSelection = original
  })

  it('returns empty string when there is no selection', () => {
    const original = window.getSelection
    window.getSelection = () => null

    expect(getTrimmedSelectionText()).toBe('')

    window.getSelection = original
  })
})

describe('suppressDefaultContextMenu', () => {
  it('prevents the default context menu', () => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    suppressDefaultContextMenu(event)
    expect(preventDefault).toHaveBeenCalled()
  })
})

describe('MessageThreadContextMenu', () => {
  beforeEach(() => {
    mocks.copyToClipboard.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    mocks.copyToClipboard.mockResolvedValue(undefined)
    mocks.downloadLocalFile.mockReset()
    mocks.downloadLocalFile.mockResolvedValue(undefined)
  })

  it('downloads a file path from inline code', async () => {
    const user = userEvent.setup()
    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>
          Play <code data-file-path="out/video.mp4">out/video.mp4</code>
        </div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('out/video.mp4'))
    await user.click(
      await screen.findByRole('menuitem', { name: /download file/i })
    )

    expect(mocks.downloadLocalFile).toHaveBeenCalledWith('/repo/out/video.mp4')
  })

  it('opens a file path from inline code in the file viewer', async () => {
    const user = userEvent.setup()
    mocks.openLocalFile.mockReturnValue(true)
    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>
          Play <code data-file-path="out/video.mp4">out/video.mp4</code>
        </div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('out/video.mp4'))
    await user.click(
      await screen.findByRole('menuitem', { name: /open file/i })
    )

    expect(mocks.openLocalFile).toHaveBeenCalledWith('out/video.mp4')
  })

  it('does not pass the click that ends a long press to the file path', async () => {
    const onClick = vi.fn()
    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>
          Play{' '}
          <code data-file-path="out/video.mp4" onClick={onClick}>
            out/video.mp4
          </code>
        </div>
      </MessageThreadContextMenu>
    )

    const code = screen.getByText('out/video.mp4')
    fireEvent.pointerDown(code, { pointerType: 'touch' })
    await screen.findByRole(
      'menuitem',
      { name: /download file/i },
      { timeout: 2000 }
    )
    fireEvent.click(code)

    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows Download file on touch long press without contextmenu (iOS)', async () => {
    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>
          Play <code data-file-path="out/video.mp4">out/video.mp4</code>
        </div>
      </MessageThreadContextMenu>
    )

    fireEvent.pointerDown(screen.getByText('out/video.mp4'), {
      pointerType: 'touch',
    })

    expect(
      await screen.findByRole(
        'menuitem',
        { name: /download file/i },
        { timeout: 2000 }
      )
    ).toBeInTheDocument()
  })

  it('opens on touch long press despite small finger jitter', async () => {
    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>
          Play <code data-file-path="out/video.mp4">out/video.mp4</code>
        </div>
      </MessageThreadContextMenu>
    )

    const code = screen.getByText('out/video.mp4')
    fireEvent.pointerDown(code, {
      pointerType: 'touch',
      clientX: 20,
      clientY: 20,
    })
    // Radix cancels its own long press on any pointermove.
    fireEvent.pointerMove(code, {
      pointerType: 'touch',
      clientX: 23,
      clientY: 22,
    })

    expect(
      await screen.findByRole(
        'menuitem',
        { name: /download file/i },
        { timeout: 2000 }
      )
    ).toBeInTheDocument()
  })

  it('does not open when the finger moves away (scroll)', async () => {
    vi.useFakeTimers()
    try {
      render(
        <MessageThreadContextMenu messageText="Full message body">
          <div>
            Play <code data-file-path="out/video.mp4">out/video.mp4</code>
          </div>
        </MessageThreadContextMenu>
      )

      const code = screen.getByText('out/video.mp4')
      fireEvent.pointerDown(code, {
        pointerType: 'touch',
        clientX: 20,
        clientY: 20,
      })
      fireEvent.pointerMove(code, {
        pointerType: 'touch',
        clientX: 20,
        clientY: 80,
      })
      vi.advanceTimersByTime(1000)

      expect(
        screen.queryByRole('menuitem', { name: /download file/i })
      ).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides Download file outside file-path code', async () => {
    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>message body</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('message body'))
    await screen.findByRole('menuitem', { name: /copy message/i })
    expect(
      screen.queryByRole('menuitem', { name: /download file/i })
    ).not.toBeInTheDocument()
  })

  it('shows Copy message and copies full text when nothing is selected', async () => {
    const user = userEvent.setup()
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '',
      }) as Selection

    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>message body</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('message body'))

    const item = await screen.findByRole('menuitem', { name: /copy message/i })
    await user.click(item)

    await waitFor(() => {
      expect(mocks.copyToClipboard).toHaveBeenCalledWith('Full message body')
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied to clipboard')
    })

    window.getSelection = original
  })

  it('shows Copy for selection and prefers selected text', async () => {
    const user = userEvent.setup()
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => 'selected bit',
      }) as Selection

    render(
      <MessageThreadContextMenu
        messageText="Full message body"
        copyMessageLabel="Copy response"
      >
        <div>message body</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('message body'))

    expect(
      await screen.findByRole('menuitem', { name: /^copy$/i })
    ).toBeVisible()
    expect(
      screen.getByRole('menuitem', { name: /copy response/i })
    ).toBeVisible()

    await user.click(screen.getByRole('menuitem', { name: /^copy$/i }))

    await waitFor(() => {
      expect(mocks.copyToClipboard).toHaveBeenCalledWith('selected bit')
    })

    window.getSelection = original
  })

  it('copies the URL when right-clicking an element inside a link', async () => {
    const user = userEvent.setup()
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '',
      }) as Selection

    render(
      <MessageThreadContextMenu messageText="Full message body">
        <div>
          <a href="/docs">
            <span>documentation</span>
          </a>
        </div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('documentation'))
    await user.click(await screen.findByRole('menuitem', { name: /copy url/i }))

    await waitFor(() => {
      expect(mocks.copyToClipboard).toHaveBeenCalledWith(
        'http://localhost:3000/docs'
      )
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied to clipboard')
    })

    window.getSelection = original
  })

  it('uses onCopyMessage when provided', async () => {
    const user = userEvent.setup()
    const onCopyMessage = vi.fn().mockResolvedValue(undefined)
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '',
      }) as Selection

    render(
      <MessageThreadContextMenu onCopyMessage={onCopyMessage}>
        <div>user prompt</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('user prompt'))
    await user.click(
      await screen.findByRole('menuitem', { name: /copy message/i })
    )

    expect(onCopyMessage).toHaveBeenCalledTimes(1)
    expect(mocks.copyToClipboard).not.toHaveBeenCalled()

    window.getSelection = original
  })

  it('shows a disabled placeholder when there is nothing to copy', async () => {
    const original = window.getSelection
    window.getSelection = () =>
      ({
        toString: () => '',
      }) as Selection

    render(
      <MessageThreadContextMenu messageText="   ">
        <div>empty-ish</div>
      </MessageThreadContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('empty-ish'))

    const item = await screen.findByRole('menuitem', {
      name: /no text to copy/i,
    })
    expect(item).toHaveAttribute('data-disabled')

    window.getSelection = original
  })
})

describe('MessageThreadContextMenu GitHub links', () => {
  beforeEach(() => {
    mocks.createWorktree.mockReset()
    mocks.createWorktree.mockResolvedValue({ id: 'new-wt' })
    mocks.fetchIssueContext.mockReset()
    mocks.fetchIssueContext.mockResolvedValue({ number: 7, title: 'Bug' })
    mocks.fetchPullRequestContext.mockReset()
    mocks.fetchPullRequestContext.mockResolvedValue({ number: 12, title: 'PR' })
  })

  const renderLink = (href: string) =>
    render(
      <MessageThreadContextMenu messageText="body">
        <div>
          <a href={href}>the link</a>
        </div>
      </MessageThreadContextMenu>
    )

  it('Cmd+click opens a PR in a new worktree in the background', async () => {
    renderLink('https://github.com/acme/app/pull/12')
    fireEvent.contextMenu(screen.getByText('the link'))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /open in new worktree/i }),
      { metaKey: true }
    )

    await waitFor(() =>
      expect(mocks.createWorktree).toHaveBeenCalledWith({
        projectId: 'proj-1',
        prContext: { number: 12, title: 'PR' },
        background: true,
      })
    )
    expect(mocks.fetchPullRequestContext).toHaveBeenCalledWith(
      '/repo',
      'proj-1',
      { number: 12, repo: undefined }
    )
    expect(useUIStore.getState().consumeAutoInvestigatePR('new-wt')).toBe(false)
  })

  it('investigates an issue from a non-primary remote in the foreground', async () => {
    renderLink('https://github.com/me/app/issues/7#issuecomment-1')
    fireEvent.contextMenu(screen.getByText('the link'))
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: /investigate in new worktree/i,
      })
    )

    await waitFor(() =>
      expect(mocks.createWorktree).toHaveBeenCalledWith({
        projectId: 'proj-1',
        issueContext: { number: 7, title: 'Bug' },
        background: false,
      })
    )
    expect(mocks.fetchIssueContext).toHaveBeenCalledWith('/repo', 'proj-1', {
      number: 7,
      repo: 'me/app',
    })
    expect(useUIStore.getState().consumeAutoInvestigate('new-wt')).toBe(true)
  })

  it('hides worktree items for a repo that is not a project remote', async () => {
    renderLink('https://github.com/other/lib/issues/3')
    fireEvent.contextMenu(screen.getByText('the link'))
    await screen.findByRole('menuitem', { name: /copy url/i })
    expect(
      screen.queryByRole('menuitem', { name: /new worktree|new session/i })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /open on web/i }))
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://github.com/other/lib/issues/3'
    )
  })

  it('investigates a primary-remote issue in a new session', async () => {
    mocks.investigateInNewSession.mockReset()
    mocks.investigateInNewSession.mockResolvedValue(undefined)
    renderLink('https://github.com/acme/app/issues/7')
    fireEvent.contextMenu(screen.getByText('the link'))
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: /investigate in new session/i,
      })
    )

    await waitFor(() =>
      expect(mocks.investigateInNewSession).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [
            expect.objectContaining({ type: 'issue', issue: { number: 7 } }),
          ],
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          projectId: 'proj-1',
          templates: { issue: 'I {issueRefs}', pr: undefined },
          openSession: true,
        })
      )
    )
  })

  it('hides the new session item for a non-primary remote', async () => {
    renderLink('https://github.com/me/app/pull/9')
    fireEvent.contextMenu(screen.getByText('the link'))
    await screen.findByRole('menuitem', {
      name: /investigate in new worktree/i,
    })
    expect(
      screen.queryByRole('menuitem', { name: /new session/i })
    ).not.toBeInTheDocument()
  })

  it('long press on a link in a table row opens the menu, not the row', async () => {
    const onRowClick = vi.fn()
    vi.useFakeTimers()
    try {
      render(
        <MessageThreadContextMenu messageText="body">
          <table>
            <tbody>
              <tr onClick={onRowClick}>
                <td>
                  <a href="https://github.com/acme/app/pull/12">#12</a>
                </td>
              </tr>
            </tbody>
          </table>
        </MessageThreadContextMenu>
      )
      const link = screen.getByText('#12')
      fireEvent.pointerDown(link, { pointerType: 'touch' })
      vi.advanceTimersByTime(500)
      fireEvent.pointerUp(link, { pointerType: 'touch' })
      fireEvent.click(link)
    } finally {
      vi.useRealTimers()
    }
    expect(
      await screen.findByRole('menuitem', {
        name: /investigate in new session/i,
      })
    ).toBeVisible()
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('only the inner of two nested menus runs the long press', async () => {
    vi.useFakeTimers()
    try {
      render(
        <MessageThreadContextMenu
          messageText="outer"
          copyMessageLabel="Copy outer"
        >
          <div>
            <MessageThreadContextMenu
              messageText="inner"
              copyMessageLabel="Copy inner"
            >
              <div>
                <a href="https://github.com/acme/app/issues/7">the link</a>
              </div>
            </MessageThreadContextMenu>
          </div>
        </MessageThreadContextMenu>
      )
      const link = screen.getByText('the link')
      fireEvent.pointerDown(link, { pointerType: 'touch' })
      vi.advanceTimersByTime(500)
    } finally {
      vi.useRealTimers()
    }
    expect(
      await screen.findByRole('menuitem', { name: /copy inner/i })
    ).toBeVisible()
    expect(
      screen.queryByRole('menuitem', { name: /copy outer/i })
    ).not.toBeInTheDocument()
  })

  it('opens the menu on a touch long press of a link', async () => {
    vi.useFakeTimers()
    try {
      renderLink('https://github.com/acme/app/pull/12')
      const link = screen.getByText('the link')
      fireEvent.pointerDown(link, { pointerType: 'touch' })
      fireEvent.pointerMove(link, { pointerType: 'touch', clientX: 4 })
      vi.advanceTimersByTime(500)
    } finally {
      vi.useRealTimers()
    }
    expect(
      await screen.findByRole('menuitem', { name: /open on web/i })
    ).toBeVisible()
  })
})
