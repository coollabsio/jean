import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { ReleaseNotesDialog } from './ReleaseNotesDialog'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  close: vi.fn(),
  setActiveSession: vi.fn(),
  setExecutionMode: vi.fn(),
  registerWorktreePath: vi.fn(),
  setSelectedBackend: vi.fn(),
  setSelectedModel: vi.fn(),
  setSelectedProvider: vi.fn(),
  setEnabledMcpServers: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invoke }))
vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    releaseNotesModalOpen: true,
    setReleaseNotesModalOpen: mocks.close,
  }),
}))
vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (selector: (state: object) => unknown) =>
    selector({ selectedProjectId: 'project-1' }),
}))
vi.mock('@/services/projects', () => ({
  useProjects: () => ({
    data: [{ id: 'project-1', name: 'Jean', path: '/repo' }],
  }),
  useWorktrees: () => ({
    data: [
      {
        id: 'base-1',
        project_id: 'project-1',
        name: 'main',
        path: '/repo',
        branch: 'main',
        created_at: 1,
        session_type: 'base',
      },
    ],
  }),
  useCreateBaseSession: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/services/chat', () => ({
  useCreateSession: () => ({ mutateAsync: mocks.createSession }),
  useSendMessage: () => ({ mutate: mocks.sendMessage }),
}))
vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      registerWorktreePath: mocks.registerWorktreePath,
      setSelectedBackend: mocks.setSelectedBackend,
      setSelectedModel: mocks.setSelectedModel,
      setSelectedProvider: mocks.setSelectedProvider,
      setEnabledMcpServers: mocks.setEnabledMcpServers,
      setActiveSession: mocks.setActiveSession,
      setExecutionMode: mocks.setExecutionMode,
      selectedBackends: {},
      selectedModels: {},
      selectedProviders: {},
    }),
  },
}))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      magic_prompts: {
        release_notes: 'Use the saved release-note voice for {tag}.',
      },
    },
  }),
}))
vi.mock('@/services/mcp', () => ({
  resolveMcpConfigForSend: () =>
    Promise.resolve({ mcpConfig: undefined, enabledServers: [] }),
}))
vi.mock('@/hooks/useGhLogin', () => ({
  useGhLogin: () => ({ triggerLogin: vi.fn(), isGhInstalled: true }),
}))
vi.mock('@/services/github', () => ({ isGhAuthError: () => false }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('ReleaseNotesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'list_github_releases') {
        return Promise.resolve([
          {
            tagName: 'v4.2.0',
            name: 'Jean 4.2',
            publishedAt: '2026-06-20T00:00:00Z',
            isLatest: true,
            isDraft: false,
            isPrerelease: false,
          },
        ])
      }
      return Promise.resolve(null)
    })
    mocks.createSession.mockResolvedValue({
      id: 'session-1',
      backend: 'claude',
    })
  })

  it('opens a session and sends a Markdown release-notes prompt after selecting a version', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    const user = userEvent.setup()
    render(<ReleaseNotesDialog />)

    await user.click(await screen.findByRole('button', { name: /jean 4\.2/i }))

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith({
        worktreeId: 'base-1',
        worktreePath: '/repo',
        name: 'Release notes since v4.2.0',
      })
    })
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        worktreeId: 'base-1',
        worktreePath: '/repo',
        message: expect.stringContaining(
          'Use the saved release-note voice for v4.2.0.'
        ),
        includeRecap: false,
      })
    )
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'generate_release_notes',
      expect.anything()
    )
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open-session-modal' })
    )
    expect(mocks.close).toHaveBeenCalledWith(false)
  })
})
