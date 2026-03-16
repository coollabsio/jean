import type { ClaudeModel, CustomCliProfile } from '@/types/preferences'
import type { ThinkingLevel, EffortLevel, ExecutionMode } from '@/types/chat'
import type { McpServerInfo } from '@/types/chat'
import type {
  PrDisplayStatus,
  CheckStatus,
  MergeableStatus,
} from '@/types/pr-status'
import type { DiffRequest } from '@/types/git-diff'
import type {
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
  AttachedSavedContext,
} from '@/types/github'
import type { LoadedLinearIssueContext } from '@/types/linear'

export interface ViewingContext {
  type: 'issue' | 'pr' | 'saved' | 'security' | 'advisory' | 'linear'
  number?: number
  slug?: string
  ghsaId?: string
  identifier?: string
  title: string
  content: string
}

export interface ChatToolbarProps {
  isSending: boolean
  hasPendingQuestions: boolean
  hasPendingAttachments: boolean
  hasInputValue: boolean
  executionMode: ExecutionMode
  selectedBackend: 'claude' | 'codex' | 'opencode'
  selectedModel: string
  selectedProvider: string | null
  selectedThinkingLevel: ThinkingLevel
  selectedEffortLevel: EffortLevel
  useAdaptiveThinking: boolean
  hideThinkingLevel?: boolean
  sessionHasMessages?: boolean
  providerLocked?: boolean

  baseBranch: string
  uncommittedAdded: number
  uncommittedRemoved: number
  branchDiffAdded: number
  branchDiffRemoved: number

  prUrl: string | undefined
  prNumber: number | undefined
  displayStatus: PrDisplayStatus | undefined
  checkStatus: CheckStatus | undefined
  mergeableStatus: MergeableStatus | undefined

  activeWorktreePath: string | undefined
  worktreeId: string | null
  activeSessionId: string | null | undefined
  projectId: string | undefined

  loadedIssueContexts: LoadedIssueContext[]
  loadedPRContexts: LoadedPullRequestContext[]
  loadedSecurityContexts: LoadedSecurityAlertContext[]
  loadedAdvisoryContexts: LoadedAdvisoryContext[]
  loadedLinearContexts: LoadedLinearIssueContext[]
  attachedSavedContexts: AttachedSavedContext[]

  onOpenMagicModal: () => void
  onSaveContext: () => void
  onLoadContext: () => void
  onCommit: () => void
  onCommitAndPush: () => void
  onOpenPr: () => void
  onReview: () => void
  onMerge: () => void
  onResolvePrConflicts: () => void
  onResolveConflicts: () => void
  hasOpenPr: boolean
  onSetDiffRequest: (request: DiffRequest) => void
  installedBackends: ('claude' | 'codex' | 'opencode')[]
  onBackendChange: (backend: 'claude' | 'codex' | 'opencode') => void
  onModelChange: (model: ClaudeModel) => void
  onProviderChange: (provider: string | null) => void
  customCliProfiles: CustomCliProfile[]
  onThinkingLevelChange: (level: ThinkingLevel) => void
  onEffortLevelChange: (level: EffortLevel) => void
  onSetExecutionMode: (mode: ExecutionMode) => void
  onCancel: () => void
  queuedMessageCount?: number

  availableMcpServers: McpServerInfo[]
  enabledMcpServers: string[]
  onToggleMcpServer: (serverName: string) => void
  onOpenProjectSettings?: () => void
}
