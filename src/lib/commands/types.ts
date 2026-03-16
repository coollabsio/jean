import type { LucideIcon } from 'lucide-react'
import type { QueryClient } from '@tanstack/react-query'
import type { Theme } from '@/lib/theme-context'
import type { ClaudeModel } from '@/types/preferences'
import type { ThinkingLevel, ExecutionMode } from '@/types/chat'

export interface AppCommand {
  id: string
  label: string
  description?: string
  icon?: LucideIcon
  group?: string
  keywords?: string[]
  execute: (context: CommandContext) => void | Promise<void>
  isAvailable?: (context: CommandContext) => boolean
  shortcut?: string
}

export interface CommandGroup {
  id: string
  label: string
  commands: AppCommand[]
}

export interface CommandContext {
  // Query client for data access
  queryClient: QueryClient

  // Preferences
  openPreferences: () => void

  // Notifications
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void

  // GitHub
  openPullRequest: () => Promise<void>

  // Git
  openCommitModal: () => void
  viewGitDiff: () => void
  rebaseWorktree: () => Promise<void>
  gitPull: () => Promise<void>
  refreshGitStatus: () => void

  // Sessions
  createSession: () => void
  closeSession: () => void
  nextSession: () => void
  previousSession: () => void
  clearSessionHistory: () => Promise<void>
  renameSession: () => void
  resumeSession: () => Promise<void>
  regenerateSessionName: () => Promise<void>

  // Worktrees
  createWorktree: () => void
  nextWorktree: () => void
  previousWorktree: () => void
  deleteWorktree: () => void
  renameWorktree: () => void

  // Open In
  openInFinder: () => Promise<void>
  openInTerminal: () => Promise<void>
  openInEditor: () => Promise<void>
  openOnGitHub: () => Promise<void>
  openOpenInModal: () => void

  // Model/Thinking
  setModel: (model: ClaudeModel) => void
  setThinkingLevel: (level: ThinkingLevel) => void

  // Execution Mode
  setExecutionMode: (mode: ExecutionMode) => void
  cycleExecutionMode: () => void

  // Theme
  setTheme: (theme: Theme) => void

  // Focus
  focusChatInput: () => void

  // Projects
  addProject: () => void
  initProject: () => void
  removeProject: () => void
  openProjectSettings: () => void

  // AI
  runAIReview: () => Promise<void>

  // Terminal
  openTerminalPanel: () => void
  runScript: () => void

  // Context
  saveContext: () => void
  loadContext: () => void

  // Archive
  openArchivedModal: () => void
  restoreLastArchived: () => void

  // Unread
  openUnreadSessions: () => void

  // Developer
  toggleDebugMode: () => void

  // State getters for isAvailable checks
  hasActiveSession: () => boolean
  hasActiveWorktree: () => boolean
  hasSelectedProject: () => boolean
  hasInstalledBackend: () => boolean
  hasMultipleSessions: () => boolean
  hasMultipleWorktrees: () => boolean
  hasRunScript: () => boolean
  getCurrentTheme: () => Theme
  getCurrentModel: () => ClaudeModel
  getCurrentThinkingLevel: () => ThinkingLevel
  getCurrentExecutionMode: () => ExecutionMode
}
