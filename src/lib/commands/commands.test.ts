import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CommandContext, AppCommand } from './types'
import { useUIStore } from '@/store/ui-store'

const { registerCommands, getAllCommands, executeCommand, clearRegistry } =
  await import('./registry')
const { notificationCommands } = await import('./notification-commands')
const { projectCommands } = await import('./project-commands')

const createMockContext = (): CommandContext => ({
  // Query client - return debug_mode_enabled for notification commands
  queryClient: {
    getQueryData: vi.fn().mockImplementation((key: string[]) => {
      if (key[0] === 'preferences') return { debug_mode_enabled: true }
      return undefined
    }),
  } as unknown as CommandContext['queryClient'],

  // Preferences
  openPreferences: vi.fn(),

  // Notifications
  showToast: vi.fn(),

  // GitHub
  openPullRequest: vi.fn().mockResolvedValue(undefined),

  // Git
  openCommitModal: vi.fn(),
  viewGitDiff: vi.fn(),
  rebaseWorktree: vi.fn().mockResolvedValue(undefined),
  gitPull: vi.fn().mockResolvedValue(undefined),
  refreshGitStatus: vi.fn(),

  // Sessions
  createSession: vi.fn(),
  closeSession: vi.fn(),
  nextSession: vi.fn(),
  previousSession: vi.fn(),
  clearSessionHistory: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn(),
  resumeSession: vi.fn().mockResolvedValue(undefined),
  regenerateSessionName: vi.fn().mockResolvedValue(undefined),

  // Worktrees
  createWorktree: vi.fn(),
  nextWorktree: vi.fn(),
  previousWorktree: vi.fn(),
  deleteWorktree: vi.fn(),
  renameWorktree: vi.fn(),

  // Open In
  openInFinder: vi.fn().mockResolvedValue(undefined),
  openInTerminal: vi.fn().mockResolvedValue(undefined),
  openInEditor: vi.fn().mockResolvedValue(undefined),
  openOnGitHub: vi.fn().mockResolvedValue(undefined),
  openOpenInModal: vi.fn(),

  // Model/Thinking
  setModel: vi.fn(),
  setThinkingLevel: vi.fn(),

  // Execution Mode
  setExecutionMode: vi.fn(),
  cycleExecutionMode: vi.fn(),

  // Theme
  setTheme: vi.fn(),

  // Focus
  focusChatInput: vi.fn(),

  // Projects
  addProject: vi.fn(),
  removeProject: vi.fn(),
  openProjectSettings: vi.fn(),

  // AI
  runAIReview: vi.fn().mockResolvedValue(undefined),

  // Terminal
  openTerminalPanel: vi.fn(),
  runScript: vi.fn(),

  // Context
  saveContext: vi.fn(),
  loadContext: vi.fn(),

  // Archive
  openArchivedModal: vi.fn(),
  restoreLastArchived: vi.fn(),

  // Unread
  openUnreadSessions: vi.fn(),

  // Developer
  copySessionDebugDetails: vi.fn().mockResolvedValue(undefined),
  // State getters
  hasActiveSession: vi.fn().mockReturnValue(true),
  hasActiveWorktree: vi.fn().mockReturnValue(true),
  hasSelectedProject: vi.fn().mockReturnValue(true),
  hasInstalledBackend: vi.fn().mockReturnValue(true),
  hasMultipleSessions: vi.fn().mockReturnValue(true),
  hasMultipleWorktrees: vi.fn().mockReturnValue(true),
  hasRunScript: vi.fn().mockReturnValue(true),
  getCurrentTheme: vi.fn().mockReturnValue('system'),
  getCurrentModel: vi.fn().mockReturnValue('opus'),
  getCurrentThinkingLevel: vi.fn().mockReturnValue('off'),
  getCurrentExecutionMode: vi.fn().mockReturnValue('plan'),
  toggleDebugMode: vi.fn(),
})

describe('Command System', () => {
  let mockContext: CommandContext

  beforeEach(() => {
    clearRegistry()
    mockContext = createMockContext()
    registerCommands(projectCommands)
    registerCommands(notificationCommands)
  })

  describe('Command Registration', () => {
    it('registers commands correctly', () => {
      const commands = getAllCommands(mockContext)
      expect(commands.length).toBeGreaterThan(0)

      const addProjectCmd = commands.find(cmd => cmd.id === 'add-project')
      expect(addProjectCmd).toBeDefined()
      expect(addProjectCmd?.label).toBe('Add Project')
    })

    it('filters commands by search term', () => {
      const searchResults = getAllCommands(mockContext, 'project')

      expect(searchResults.length).toBeGreaterThan(0)
      searchResults.forEach(cmd => {
        const matchesSearch =
          cmd.label.toLowerCase().includes('project') ||
          cmd.description?.toLowerCase().includes('project') ||
          cmd.keywords?.some(kw => kw.toLowerCase().includes('project'))

        expect(matchesSearch).toBe(true)
      })
    })
  })

  describe('Command Execution', () => {
    it('executes add-project command correctly', async () => {
      const result = await executeCommand('add-project', mockContext)

      expect(result.success).toBe(true)
      expect(mockContext.addProject).toHaveBeenCalled()
    })
    it('handles non-existent command', async () => {
      const result = await executeCommand('non-existent-command', mockContext)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('handles command execution errors', async () => {
      const errorCommand: AppCommand = {
        id: 'error-command',
        label: 'Error Command',
        execute: () => {
          throw new Error('Test error')
        },
      }

      registerCommands([errorCommand])

      const result = await executeCommand('error-command', mockContext)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Test error')
    })
  })
})

describe('Project Commands', () => {
  let mockContext: CommandContext

  beforeEach(() => {
    clearRegistry()
    mockContext = createMockContext()
    registerCommands(projectCommands)
    useUIStore.setState({
      featureTourOpen: false,
      onboardingOpen: false,
      onboardingManuallyTriggered: false,
      onboardingDismissed: true,
    })
  })

  it('registers all project commands', () => {
    const commands = getAllCommands(mockContext)
    const projectIds = ['add-project']
    const found = commands.filter(cmd => projectIds.includes(cmd.id))
    expect(found.length).toBe(1)
  })

  it('add-project is always available', () => {
    const commands = getAllCommands(mockContext)
    const addCmd = commands.find(c => c.id === 'add-project')
    expect(addCmd).toBeDefined()
  })
  it('copy debug details command uses clipboard action', async () => {
    const result = await executeCommand('toggle-debug-mode', mockContext)

    expect(result.success).toBe(true)
    expect(mockContext.copySessionDebugDetails).toHaveBeenCalled()
    expect(mockContext.toggleDebugMode).not.toHaveBeenCalled()
  })

  it('feature tour command replays the product tour directly', async () => {
    const result = await executeCommand('help.feature-tour', mockContext)

    expect(result.success).toBe(true)
    expect(useUIStore.getState().featureTourOpen).toBe(true)
    expect(useUIStore.getState().onboardingOpen).toBe(false)
    expect(useUIStore.getState().onboardingManuallyTriggered).toBe(false)
  })

  it('backend setup command opens onboarding in manual install mode', async () => {
    const result = await executeCommand('help.install-ai-backends', mockContext)

    expect(result.success).toBe(true)
    expect(useUIStore.getState().onboardingOpen).toBe(true)
    expect(useUIStore.getState().onboardingManuallyTriggered).toBe(true)
    expect(useUIStore.getState().onboardingDismissed).toBe(false)
    expect(useUIStore.getState().featureTourOpen).toBe(false)
  })

  it('rename session command delegates to session rename wiring', async () => {
    const result = await executeCommand('rename-session', mockContext)

    expect(result.success).toBe(true)
    expect(mockContext.renameSession).toHaveBeenCalled()
  })
})

describe('Notification Commands', () => {
  let mockContext: CommandContext

  beforeEach(() => {
    clearRegistry()
    mockContext = createMockContext()
    registerCommands(notificationCommands)
  })

  it('registers test toast command', () => {
    const commands = getAllCommands(mockContext)
    const toastCmd = commands.find(c => c.id === 'notification.test-toast')
    expect(toastCmd).toBeDefined()
    expect(toastCmd?.label).toBe('Test Toast Notification')
  })
})

describe('All Commands Combined', () => {
  let mockContext: CommandContext

  beforeEach(() => {
    clearRegistry()
    mockContext = createMockContext()
    registerCommands(projectCommands)
    registerCommands(notificationCommands)
  })

  it('registers all command groups', () => {
    const commands = getAllCommands(mockContext)
    const groups = new Set(commands.map(c => c.group).filter(Boolean))

    expect(groups.has('projects')).toBe(true)
    expect(groups.has('debug')).toBe(true)
  })

  it('commands have unique IDs', () => {
    const commands = getAllCommands(mockContext)
    const ids = commands.map(c => c.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  it('search filters across all command groups', () => {
    const results = getAllCommands(mockContext, 'project')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(c => c.id.includes('project'))).toBe(true)
  })

  it('keyword search works', () => {
    const results = getAllCommands(mockContext, 'git')
    expect(results.length).toBeGreaterThan(0)
  })
})
