import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Zap,
  ArrowLeft,
  CircleDot,
  GitPullRequest,
  Shield,
  GitBranch,
  Bug,
} from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { LucideIcon } from 'lucide-react'
import { useGhLogin } from '@/hooks/useGhLogin'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useNewWorktreeData } from './hooks/useNewWorktreeData'
import { useNewWorktreeHandlers } from './hooks/useNewWorktreeHandlers'
import { useNewWorktreeKeyboard } from './hooks/useNewWorktreeKeyboard'
import { normalizeRunScripts } from '@/services/projects'
import { SessionTabBar } from './NewWorktreeItems'
import { GitHubIssuesTab } from './GitHubIssuesTab'
import { GitHubPRsTab } from './GitHubPRsTab'
import { SecurityAlertsTab } from './SecurityAlertsTab'
import { BranchesTab } from './BranchesTab'
import { LinearIssuesTab } from './LinearIssuesTab'
import { SentryIssuesTab } from './SentryIssuesTab'
import { IssuePreviewModal } from './IssuePreviewModal'
import {
  NewSessionComposer,
  type NewSessionComposerSettings,
} from './NewSessionComposer'
import type {
  DependabotAlert,
  GitHubIssue,
  GitHubPullRequest,
  RepositoryAdvisory,
} from '@/types/github'
import type { LinearIssue } from '@/types/linear'
import type { SentryIssue } from '@/types/sentry'
import {
  describeNewSessionSource,
  getNewSessionDialogSizeClass,
  type NewSessionSource,
} from './new-session-draft'

export type { NewSessionTabId as TabId } from './new-session-draft'
import type { NewSessionTabId as TabId } from './new-session-draft'

export interface Tab {
  id: TabId
  label: string
  key: string
  icon: LucideIcon
}

// eslint-disable-next-line react-refresh/only-export-components
export const TABS: Tab[] = [
  { id: 'quick', label: 'Actions', key: '1', icon: Zap },
  { id: 'issues', label: 'Issues', key: '2', icon: CircleDot },
  { id: 'prs', label: 'PRs', key: '3', icon: GitPullRequest },
  { id: 'security', label: 'Security', key: '4', icon: Shield },
  { id: 'branches', label: 'Branches', key: '5', icon: GitBranch },
  { id: 'linear', label: 'Linear', key: '6', icon: LinearIcon },
  { id: 'sentry', label: 'Sentry', key: '7', icon: Bug },
]

const SOURCE_TABS = TABS.filter(tab => tab.id !== 'quick')

export function NewWorktreeModal() {
  const { triggerLogin: triggerGhLogin, isGhInstalled } = useGhLogin()
  const { newWorktreeModalOpen } = useUIStore()

  // Local state
  const [activeTab, setActiveTab] = useState<TabId>('quick')
  const [searchQuery, setSearchQuery] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [selectedItemIndex, setSelectedItemIndex] = useState(0)
  const [source, setSource] = useState<NewSessionSource | null>(null)
  const [composerSettings, setComposerSettings] =
    useState<NewSessionComposerSettings | null>(null)
  const [previewItem, setPreviewItem] = useState<{
    type: 'issue' | 'pr' | 'security' | 'advisory'
    number: number
    ghsaId?: string
  } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Track preview-was-open across the same event cycle (ref survives after state clears)
  const previewOpenRef = useRef(false)
  const draftProjectIdRef = useRef<string | null>(null)

  // Tab changes also reset list selection/search (avoid effect chain on activeTab)
  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab)
    setSelectedItemIndex(0)
    setSearchQuery('')
  }, [])

  // Hooks
  const data = useNewWorktreeData(searchQuery, includeClosed)
  const handlers = useNewWorktreeHandlers(data, {
    setActiveTab: handleTabChange,
    setSearchQuery,
    setSelectedItemIndex,
    setIncludeClosed,
  })
  const handleComposerSettingsChange = useCallback(
    (settings: NewSessionComposerSettings) => {
      draftProjectIdRef.current = data.selectedProjectId
      setComposerSettings(settings)
    },
    [data.selectedProjectId]
  )

  const handleProjectSelect = useCallback(
    (projectId: string) => {
      if (projectId === data.selectedProjectId) return
      setSource(null)
      setComposerSettings(null)
      draftProjectIdRef.current = projectId
      useProjectsStore.getState().selectProject(projectId)
      handleTabChange('quick')
    },
    [data.selectedProjectId, handleTabChange]
  )

  const handlePreviewIssue = (issue: { number: number }) => {
    previewOpenRef.current = true
    setPreviewItem({ type: 'issue', number: issue.number })
  }

  const handlePreviewPR = (pr: { number: number }) => {
    previewOpenRef.current = true
    setPreviewItem({ type: 'pr', number: pr.number })
  }

  const handlePreviewSecurityAlert = (alert: { number: number }) => {
    previewOpenRef.current = true
    setPreviewItem({ type: 'security', number: alert.number })
  }

  const handlePreviewAdvisory = (advisory: { ghsaId: string }) => {
    // Advisories use ghsaId as identifier; we pass number=0 since it's not number-based
    previewOpenRef.current = true
    setPreviewItem({ type: 'advisory', number: 0, ghsaId: advisory.ghsaId })
  }

  const selectSource = useCallback(
    (source: NewSessionSource) => {
      draftProjectIdRef.current = data.selectedProjectId
      setSource(source)
      handleTabChange('quick')
    },
    [data.selectedProjectId, handleTabChange]
  )

  const handleDraftIssue = useCallback(
    (item: GitHubIssue) => selectSource({ type: 'issue', item }),
    [selectSource]
  )
  const handleDraftPR = useCallback(
    (item: GitHubPullRequest) => selectSource({ type: 'pr', item }),
    [selectSource]
  )
  const handleDraftStackPR = useCallback(
    (item: GitHubPullRequest) => selectSource({ type: 'stack-pr', item }),
    [selectSource]
  )
  const handleDraftAlert = useCallback(
    (item: DependabotAlert) => selectSource({ type: 'security', item }),
    [selectSource]
  )
  const handleDraftAdvisory = useCallback(
    (item: RepositoryAdvisory) => selectSource({ type: 'advisory', item }),
    [selectSource]
  )
  const handleDraftBranch = useCallback(
    (branch: string) => selectSource({ type: 'branch', branch }),
    [selectSource]
  )
  const handleDraftLinearIssue = useCallback(
    (item: LinearIssue) => selectSource({ type: 'linear', item }),
    [selectSource]
  )
  const handleDraftSentryIssue = useCallback(
    (item: SentryIssue) => selectSource({ type: 'sentry', item }),
    [selectSource]
  )

  // With several remotes the quick actions are per-remote, so the "N" shortcut
  // targets the first one (origin) instead of the project default branch.
  const defaultBranch = data.selectedProject?.default_branch
  const { handleKeyDown } = useNewWorktreeKeyboard({
    activeTab,
    setActiveTab: handleTabChange,
    filteredIssues: data.filteredIssues,
    filteredPRs: data.filteredPRs,
    filteredSecurityAlerts: data.filteredSecurityAlerts,
    filteredBranches: data.filteredBranches,
    selectedItemIndex,
    setSelectedItemIndex,
    creatingFromNumber: handlers.creatingFromNumber,
    handleBaseSession: handlers.handleBaseSession,
    handleSelectIssue: handleDraftIssue,
    handleSelectIssueAndInvestigate: handlers.handleSelectIssueAndInvestigate,
    handlePreviewIssue,
    handleSelectPR: handleDraftPR,
    handleSelectPRAndInvestigate: handlers.handleSelectPRAndInvestigate,
    handlePreviewPR,
    handleSelectSecurityAlert: handleDraftAlert,
    handleSelectSecurityAlertAndInvestigate:
      handlers.handleSelectSecurityAlertAndInvestigate,
    handlePreviewSecurityAlert,
    filteredAdvisories: data.filteredAdvisories,
    handleSelectAdvisory: handleDraftAdvisory,
    handleSelectAdvisoryAndInvestigate:
      handlers.handleSelectAdvisoryAndInvestigate,
    handlePreviewAdvisory,
    handleSelectBranch: handleDraftBranch,
    filteredLinearIssues: data.filteredLinearIssues,
    handleSelectLinearIssue: handleDraftLinearIssue,
    handleSelectLinearIssueAndInvestigate:
      handlers.handleSelectLinearIssueAndInvestigate,
    filteredSentryIssues: data.filteredSentryIssues,
    handleSelectSentryIssue: handleDraftSentryIssue,
    handleSelectSentryIssueAndInvestigate:
      handlers.handleSelectSentryIssueAndInvestigate,
  })

  // Apply store-provided default tab when modal opens (resets selection via handleTabChange)
  useEffect(() => {
    if (newWorktreeModalOpen) {
      const { newWorktreeModalDefaultTab, setNewWorktreeModalDefaultTab } =
        useUIStore.getState()
      if (newWorktreeModalDefaultTab) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        handleTabChange(newWorktreeModalDefaultTab)
        setNewWorktreeModalDefaultTab(null)
      }
    }
  }, [newWorktreeModalOpen, handleTabChange])

  // Focus search input when switching to searchable tabs
  useEffect(() => {
    if (
      (activeTab === 'issues' ||
        activeTab === 'prs' ||
        activeTab === 'security' ||
        activeTab === 'branches' ||
        activeTab === 'linear' ||
        activeTab === 'sentry') &&
      newWorktreeModalOpen
    ) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [activeTab, newWorktreeModalOpen])

  const handleDialogOpenChange = (open: boolean) => {
    if (!open && (previewItem || previewOpenRef.current)) return
    if (!open && activeTab !== 'quick') {
      handleTabChange('quick')
      return
    }
    if (
      open &&
      draftProjectIdRef.current !== null &&
      draftProjectIdRef.current !== data.selectedProjectId
    ) {
      setSource(null)
      setComposerSettings(null)
      draftProjectIdRef.current = data.selectedProjectId
    }
    handlers.handleOpenChange(open)
  }

  return (
    <>
      <Dialog
        open={newWorktreeModalOpen && activeTab === 'quick'}
        onOpenChange={handleDialogOpenChange}
      >
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          className={cn(
            '!h-auto !max-h-[calc(100dvh-1rem)] !w-[calc(100vw-1rem)] !max-w-[calc(100vw-1rem)] !rounded-2xl p-0 flex flex-col overflow-hidden gap-0',
            getNewSessionDialogSizeClass('quick')
          )}
        >
          <DialogTitle className="sr-only">Start something new</DialogTitle>
          <NewSessionComposer
            projectId={data.selectedProjectId}
            projectName={data.selectedProject?.name ?? 'Project'}
            projects={data.projects}
            onSelectProject={handleProjectSelect}
            projectPath={data.selectedProject?.path}
            defaultBranch={defaultBranch}
            remotes={data.remotes ?? []}
            branches={data.branches}
            isLoadingBranches={data.isLoadingBranches}
            setupScript={data.jeanConfig?.scripts.setup}
            onSelectBase={() => setSource({ type: 'base' })}
            hasBaseSession={data.hasBaseSession}
            showConfigureProject={
              normalizeRunScripts(data.jeanConfig?.scripts.run).length === 0
            }
            onConfigureProject={() => {
              handlers.handleOpenChange(false)
              if (data.selectedProjectId) {
                useProjectsStore
                  .getState()
                  .openProjectSettings(data.selectedProjectId, 'jean-json')
              }
            }}
            source={source}
            sourceContext={source ? describeNewSessionSource(source) : null}
            onClearSourceContext={() => setSource(null)}
            onCreated={() => {
              handlers.handleOpenChange(false)
            }}
            onCompleted={() => {
              setSource(null)
              setComposerSettings(null)
              draftProjectIdRef.current = null
            }}
            onRetry={() => {
              useUIStore.setState({
                commandPaletteOpen: false,
                newWorktreeModalDefaultTab: null,
                newWorktreeModalOpen: true,
              })
            }}
            onConfigureBackends={() => {
              handlers.handleOpenChange(false)
              requestAnimationFrame(() => {
                useUIStore.getState().openPreferencesPane('general')
              })
            }}
            createWorktree={args => data.createWorktree.mutateAsync(args)}
            createWorktreeFromBranch={async branchName => {
              if (!data.selectedProjectId) {
                throw new Error('No project selected')
              }
              return data.createWorktreeFromBranch.mutateAsync({
                projectId: data.selectedProjectId,
                branchName,
                background: true,
              })
            }}
            createBaseSession={() => {
              if (!data.selectedProjectId) {
                return Promise.reject(new Error('No project selected'))
              }
              return data.createBaseSession.mutateAsync(data.selectedProjectId)
            }}
            initialSettings={composerSettings}
            onSettingsChange={handleComposerSettingsChange}
            onOpenTab={handleTabChange}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={newWorktreeModalOpen && activeTab !== 'quick'}
        onOpenChange={handleDialogOpenChange}
      >
        <DialogContent
          aria-describedby={undefined}
          className={cn(
            '!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!rounded-lg p-0 flex flex-col overflow-hidden',
            getNewSessionDialogSizeClass('issues')
          )}
          onKeyDown={handleKeyDown}
          onEscapeKeyDown={e => {
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
          onPointerDownOutside={e => {
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
          onInteractOutside={e => {
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
          onFocusOutside={e => {
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
        >
          <DialogHeader className="border-b px-5 py-4">
            <div className="flex items-start gap-3">
              <button
                type="button"
                aria-label="Back to prompt"
                onClick={() => handleTabChange('quick')}
                className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div>
                <DialogTitle className="text-base">
                  Create from existing context
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Choose an item to attach to your prompt in{' '}
                  {data.selectedProject?.name ?? 'Project'}.
                </p>
              </div>
            </div>
          </DialogHeader>

          {/* Tabs */}
          <SessionTabBar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            tabs={SOURCE_TABS}
          />

          {/* Tab content */}
          <div className="flex-1 min-h-0 flex flex-col">
            {activeTab === 'issues' && (
              <GitHubIssuesTab
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                includeClosed={includeClosed}
                setIncludeClosed={setIncludeClosed}
                issues={data.filteredIssues}
                isLoading={data.isLoadingIssues}
                isRefetching={data.isRefetchingIssues}
                isSearching={data.isSearchingIssues}
                error={data.issuesError}
                onRefresh={() => data.refetchIssues()}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectIssue={handleDraftIssue}
                onInvestigateIssue={handlers.handleSelectIssueAndInvestigate}
                onBulkInvestigateIssues={handlers.handleBulkInvestigateIssues}
                onPreviewIssue={handlePreviewIssue}
                creatingFromNumber={handlers.creatingFromNumber}
                isBulkInvestigating={handlers.isBulkInvestigating}
                searchInputRef={searchInputRef}
                onGhLogin={triggerGhLogin}
                isGhInstalled={isGhInstalled}
              />
            )}

            {activeTab === 'prs' && (
              <GitHubPRsTab
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                includeClosed={includeClosed}
                setIncludeClosed={setIncludeClosed}
                prs={data.filteredPRs}
                isLoading={data.isLoadingPRs}
                isRefetching={data.isRefetchingPRs}
                isSearching={data.isSearchingPRs}
                error={data.prsError}
                onRefresh={() => data.refetchPRs()}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectPR={handleDraftPR}
                onInvestigatePR={handlers.handleSelectPRAndInvestigate}
                onBulkInvestigatePRs={handlers.handleBulkInvestigatePRs}
                onStackPR={handleDraftStackPR}
                onPreviewPR={handlePreviewPR}
                creatingFromNumber={handlers.creatingFromNumber}
                stackingFromPR={handlers.stackingFromPR}
                isBulkInvestigating={handlers.isBulkInvestigating}
                searchInputRef={searchInputRef}
                onGhLogin={triggerGhLogin}
                isGhInstalled={isGhInstalled}
              />
            )}

            {activeTab === 'security' && (
              <SecurityAlertsTab
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                includeClosed={includeClosed}
                setIncludeClosed={setIncludeClosed}
                alerts={data.filteredSecurityAlerts}
                isLoading={data.isLoadingSecurityAlerts}
                isRefetching={data.isRefetchingSecurityAlerts}
                error={data.securityError}
                onRefresh={() => {
                  data.refetchSecurityAlerts()
                  data.refetchAdvisories()
                }}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectAlert={handleDraftAlert}
                onInvestigateAlert={
                  handlers.handleSelectSecurityAlertAndInvestigate
                }
                onPreviewAlert={handlePreviewSecurityAlert}
                creatingFromNumber={handlers.creatingFromNumber}
                searchInputRef={searchInputRef}
                onGhLogin={triggerGhLogin}
                isGhInstalled={isGhInstalled}
                filteredAdvisories={data.filteredAdvisories}
                isLoadingAdvisories={data.isLoadingAdvisories}
                isRefetchingAdvisories={data.isRefetchingAdvisories}
                onSelectAdvisory={handleDraftAdvisory}
                onInvestigateAdvisory={
                  handlers.handleSelectAdvisoryAndInvestigate
                }
                onPreviewAdvisory={handlePreviewAdvisory}
                creatingFromGhsaId={handlers.creatingFromGhsaId}
                onBulkInvestigateSecurity={
                  handlers.handleBulkInvestigateSecurity
                }
                isBulkInvestigating={handlers.isBulkInvestigating}
              />
            )}

            {activeTab === 'linear' && (
              <LinearIssuesTab
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                issues={data.filteredLinearIssues}
                isLoading={data.isLoadingLinearIssues}
                isRefetching={data.isRefetchingLinearIssues}
                isSearching={data.isSearchingLinearIssues}
                error={data.linearIssuesError}
                onRefresh={() => data.refetchLinearIssues()}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectIssue={handleDraftLinearIssue}
                onInvestigateIssue={
                  handlers.handleSelectLinearIssueAndInvestigate
                }
                onBulkInvestigateIssues={
                  handlers.handleBulkInvestigateLinearIssues
                }
                creatingFromId={handlers.creatingFromLinearId}
                isBulkInvestigating={handlers.isBulkInvestigating}
                searchInputRef={searchInputRef}
              />
            )}

            {activeTab === 'sentry' && (
              <SentryIssuesTab
                projectId={data.selectedProjectId ?? ''}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                issues={data.filteredSentryIssues}
                isLoading={data.isLoadingSentryIssues}
                isRefetching={data.isRefetchingSentryIssues}
                error={data.sentryIssuesError}
                onRefresh={() => data.refetchSentryIssues()}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectIssue={handleDraftSentryIssue}
                onInvestigateIssue={
                  handlers.handleSelectSentryIssueAndInvestigate
                }
                onBulkInvestigateIssues={
                  handlers.handleBulkInvestigateSentryIssues
                }
                creatingFromId={handlers.creatingFromSentryId}
                isBulkInvestigating={handlers.isBulkInvestigating}
                searchInputRef={searchInputRef}
              />
            )}

            {activeTab === 'branches' && (
              <BranchesTab
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                branches={data.filteredBranches}
                isLoading={data.isLoadingBranches}
                isRefetching={data.isRefetchingBranches}
                error={data.branchesError}
                onRefresh={() => data.refetchBranches()}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectBranch={handleDraftBranch}
                creatingFromBranch={handlers.creatingFromBranch}
                searchInputRef={searchInputRef}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      {previewItem && data.selectedProject && (
        <IssuePreviewModal
          open={!!previewItem}
          onOpenChange={open => {
            if (!open) {
              previewOpenRef.current = true
              setPreviewItem(null)
              // Clear ref after the current event cycle so parent guards still block
              requestAnimationFrame(() => {
                previewOpenRef.current = false
              })
            }
          }}
          projectPath={data.selectedProject.path}
          type={previewItem.type}
          number={previewItem.number}
          ghsaId={previewItem.ghsaId}
        />
      )}
    </>
  )
}

export default NewWorktreeModal
