import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { OpenInModal } from './OpenInModal'

const localBackendState = vi.hoisted(() => ({ value: true }))
const nativeOpenAllowedState = vi.hoisted(() => ({ value: false }))

const mocks = vi.hoisted(() => ({
  setOpenInModalOpen: vi.fn(),
  openPreferencesPane: vi.fn(),
  openRemotePicker: vi.fn(),
  openExternal: vi.fn(),
}))

interface UiStoreMock {
  openInModalOpen: boolean
  setOpenInModalOpen: typeof mocks.setOpenInModalOpen
  openPreferencesPane: typeof mocks.openPreferencesPane
  sessionChatModalWorktreeId: string | null
  openRemotePicker: typeof mocks.openRemotePicker
}

interface ProjectsStoreMock {
  selectedWorktreeId: string
  selectedProjectId: string
}

interface ChatStoreMock {
  activeWorktreeId: string | null
  activeSessionIds: Record<string, string>
}

vi.mock('@/store/ui-store', () => ({
  useUIStore: (selector?: (state: UiStoreMock) => unknown) => {
    const state = {
      openInModalOpen: true,
      setOpenInModalOpen: mocks.setOpenInModalOpen,
      openPreferencesPane: mocks.openPreferencesPane,
      sessionChatModalWorktreeId: null,
      openRemotePicker: mocks.openRemotePicker,
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (selector?: (state: ProjectsStoreMock) => unknown) => {
    const state = {
      selectedWorktreeId: 'wt-1',
      selectedProjectId: 'project-1',
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: Object.assign(
    (selector?: (state: ChatStoreMock) => unknown) => {
      const state = {
        activeWorktreeId: null,
        activeSessionIds: { 'wt-1': 'session-1' },
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        getWorktreePath: () => '/repo/worktree',
      }),
    }
  ),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { editor: 'zed', terminal: 'ghostty' },
  }),
}))

vi.mock('@/lib/environment', () => ({
  isLocalBackend: () => localBackendState.value,
  isNativeApp: () => localBackendState.value,
  canOpenNativeApps: () =>
    localBackendState.value || nativeOpenAllowedState.value,
  isNativeOpenAllowed: () => nativeOpenAllowedState.value,
}))

vi.mock('@/lib/platform', () => ({
  openExternal: mocks.openExternal,
  isMacOS: true,
  isWindows: false,
  isLinux: false,
  getServerPlatform: vi.fn(() => 'mac'),
  isServerWindows: vi.fn(() => false),
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/lib/notifications', () => ({
  notify: vi.fn(),
}))

vi.mock('@/services/projects', () => ({
  useWorktree: () => ({
    data: {
      id: 'wt-1',
      path: '/repo/worktree',
      branch: 'fix-advisory',
      pr_url: null,
      pr_number: null,
      security_alert_url: 'https://github.com/acme/app/security/dependabot/7',
      security_alert_number: 7,
      advisory_url:
        'https://github.com/acme/app/security/advisories/GHSA-892v-qq52-xprh',
      advisory_ghsa_id: 'GHSA-892v-qq52-xprh',
    },
  }),
  useProjects: () => ({
    data: [{ id: 'project-1', path: '/repo', name: 'app' }],
  }),
  useOpenWorktreeInFinder: () => ({ mutate: vi.fn() }),
  useOpenWorktreeInTerminal: () => ({ mutate: vi.fn() }),
  useOpenWorktreeInEditor: () => ({ mutate: vi.fn() }),
  usePorts: () => ({ data: [] }),
}))

vi.mock('@/services/github', () => ({
  useLoadedIssueContexts: () => ({ data: [] }),
  useLoadedPRContexts: () => ({ data: [] }),
  useLoadedSecurityContexts: vi.fn((sessionId: string, worktreeId: string) => ({
    data:
      sessionId === 'session-1' && worktreeId === 'wt-1'
        ? [
            {
              number: 9,
              packageName: 'lodash',
              summary: 'Prototype pollution',
              severity: 'high',
              repoOwner: 'acme',
              repoName: 'app',
            },
          ]
        : [],
  })),
  useLoadedAdvisoryContexts: vi.fn((sessionId: string, worktreeId: string) => ({
    data:
      sessionId === 'session-1' && worktreeId === 'wt-1'
        ? [
            {
              ghsaId: 'GHSA-loaded-1234-5678',
              summary: 'Loaded advisory',
              severity: 'critical',
              repoOwner: 'acme',
              repoName: 'app',
            },
          ]
        : [],
  })),
}))

describe('OpenInModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localBackendState.value = true
    nativeOpenAllowedState.value = false
  })

  it('hides Finder/editor/terminal in browser/headless mode without native open', async () => {
    localBackendState.value = false
    nativeOpenAllowedState.value = false

    render(<OpenInModal />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(screen.queryByText('Finder')).not.toBeInTheDocument()
    expect(screen.queryByText('Zed')).not.toBeInTheDocument()
    expect(screen.queryByText('Ghostty')).not.toBeInTheDocument()
  })

  it('shows Finder/editor/terminal when the backend allows native open', async () => {
    // Browser or remote client against a WSL/--allow-native-open headless server.
    localBackendState.value = false
    nativeOpenAllowedState.value = true

    render(<OpenInModal />)

    expect(await screen.findByText('Zed')).toBeInTheDocument()
    expect(screen.getByText('Finder')).toBeInTheDocument()
    expect(screen.getByText('Ghostty')).toBeInTheDocument()
  })

  it('hides Finder/editor/terminal on remote connections without native open', async () => {
    // Native shell with a remote Jean backend that does not allow native open.
    localBackendState.value = false
    nativeOpenAllowedState.value = false

    render(<OpenInModal />)

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(screen.queryByText('Finder')).not.toBeInTheDocument()
    expect(screen.queryByText(/zed|editor/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/ghostty|terminal/i)).not.toBeInTheDocument()
  })

  it('shows local open targets when connected to the local backend', async () => {
    render(<OpenInModal />)

    expect(await screen.findByText('Zed')).toBeInTheDocument()
    expect(screen.getByText('Ghostty')).toBeInTheDocument()
    expect(screen.getByText('Finder')).toBeInTheDocument()
    expect(screen.getByText('GitHub')).toBeInTheDocument()
  })

  it('shows worktree and loaded security/advisory context URLs', async () => {
    render(<OpenInModal />)

    expect(
      await screen.findByText('Advisory GHSA-892v-qq52-xprh')
    ).toBeInTheDocument()
    expect(screen.getByText('Security #7')).toBeInTheDocument()
    expect(screen.getByText('Security #9')).toBeInTheDocument()
    expect(
      screen.getByText('Advisory GHSA-loaded-1234-5678')
    ).toBeInTheDocument()
  })
})
