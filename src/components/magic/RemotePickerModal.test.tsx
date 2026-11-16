import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/test-utils'
import { RemotePickerModal } from './RemotePickerModal'

const isMobileState = vi.hoisted(() => ({ value: false }))
const mocks = vi.hoisted(() => ({
  closeRemotePicker: vi.fn(),
  getGitRemotes: vi.fn(),
  removeGitRemote: vi.fn(),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileState.value,
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    remotePickerOpen: true,
    remotePickerRepoPath: '/repo',
    remotePickerOwner: { worktreeId: 'wt-1' },
    closeRemotePicker: mocks.closeRemotePicker,
  }),
  getRemotePickerCallback: () => vi.fn(),
}))

vi.mock('@/services/git-status', () => ({
  getGitRemotes: (...args: unknown[]) => mocks.getGitRemotes(...args),
  removeGitRemote: (...args: unknown[]) => mocks.removeGitRemote(...args),
}))

describe('RemotePickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isMobileState.value = false
    mocks.getGitRemotes.mockResolvedValue([
      { name: 'origin', url: 'git@github.com:acme/app.git' },
      { name: 'adiologydev', url: 'git@github.com:adiologydev/app.git' },
    ])
    mocks.removeGitRemote.mockResolvedValue(undefined)
  })

  it('always shows the removable remote delete button on mobile', async () => {
    isMobileState.value = true

    render(<RemotePickerModal />)

    expect(await screen.findByText('origin')).toBeInTheDocument()
    expect(screen.getByText('adiologydev')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /remove adiologydev remote/i })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /remove origin remote/i })
    ).not.toBeInTheDocument()
  })

  it('keeps unfocused remote delete buttons hidden on desktop', async () => {
    render(<RemotePickerModal />)

    await waitFor(() => {
      expect(screen.getByText('adiologydev')).toBeInTheDocument()
    })

    expect(
      screen.queryByRole('button', { name: /remove adiologydev remote/i })
    ).not.toBeInTheDocument()
  })
})
