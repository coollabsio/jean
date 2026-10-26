import { useCallback, useEffect, useRef, useState } from 'react'
import { getModifierSymbol } from '@/lib/platform'
import { Kbd } from '@/components/ui/kbd'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  Zap,
  CircleDot,
  GitPullRequest,
  Shield,
  GitBranch,
  Sentry,
  MessagesSquare,
} from '@/components/icons/reicon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { LucideIcon } from '@/components/icons/reicon'
import { useGhLogin } from '@/hooks/useGhLogin'
import { usePreferences } from '@/services/preferences'
import {
  resolveMagicPromptProvider,
  resolveMagicPromptBackend,
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  type CliBackend,
} from '@/types/preferences'
import { DesktopBackendModelPicker } from '@/components/chat/toolbar/DesktopBackendModelPicker'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useContextLinkUsage } from '@/hooks/useContextLinkUsage'
import { resolveSelectedModelForBackend } from '@/lib/session-defaults'
import { useGlabLogin } from '@/hooks/useGlabLogin'
import { useProjectGitProvider, providerLabels } from '@/services/git-provider'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { parseServerResourceKey } from '@/lib/server-resource'
import { SettingsTargetProvider } from '@/lib/settings-target'
import { useNewWorktreeData } from './hooks/useNewWorktreeData'
import { useNewWorktreeHandlers } from './hooks/useNewWorktreeHandlers'
import { useNewWorktreeKeyboard } from './hooks/useNewWorktreeKeyboard'
import { SessionTabBar } from './NewWorktreeItems'
import { QuickActionsTab } from './QuickActionsTab'
import { GitHubIssuesTab } from './GitHubIssuesTab'
import { GitHubPRsTab } from './GitHubPRsTab'
import { SecurityAlertsTab } from './SecurityAlertsTab'
import { BranchesTab } from './BranchesTab'
import { LinearIssuesTab } from './LinearIssuesTab'
import { SentryIssuesTab } from './SentryIssuesTab'
import { GitHubDiscussionsTab } from './GitHubDiscussionsTab'
import { IssuePreviewModal } from './IssuePreviewModal'
import { StartOnHostPicker, useStartOnHost } from './StartOnHost'

export type TabId =
  | 'quick'
  | 'issues'
  | 'prs'
  | 'security'
  | 'branches'
  | 'linear'
  | 'sentry'
  | 'discussions'

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
  { id: 'sentry', label: 'Sentry', key: '7', icon: Sentry },
  { id: 'discussions', label: 'Discussions', key: '8', icon: MessagesSquare },
]

export function NewWorktreeModal() {
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const serverId = selectedProjectId
    ? (parseServerResourceKey(selectedProjectId)?.serverId ?? 'local')
    : 'local'

  return (
    <SettingsTargetProvider serverId={serverId}>
      <NewWorktreeModalContent />
    </SettingsTargetProvider>
  )
}

function NewWorktreeModalContent() {
  const { triggerLogin: triggerGhLogin, isGhInstalled } = useGhLogin()
  const { triggerLogin: triggerGlabLogin, isGlabInstalled } = useGlabLogin()
  const { newWorktreeModalOpen } = useUIStore()
  const isMobile = useIsMobile()

  // Local state
  const [activeTab, setActiveTab] = useState<TabId>('quick')
  const [searchQuery, setSearchQuery] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [selectedItemIndex, setSelectedItemIndex] = useState(0)
  const [investigationBackend, setInvestigationBackend] =
    useState<CliBackend>('claude')
  const [investigationModel, setInvestigationModel] = useState('sonnet')
  const [investigationProvider, setInvestigationProvider] =
    useState('__anthropic__')
  const [previewItem, setPreviewItem] = useState<{
    type: 'issue' | 'pr' | 'security' | 'advisory'
    number: number
    ghsaId?: string
    repo?: string
  } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Track preview-was-open across the same event cycle (ref survives after state clears)
  const previewOpenRef = useRef(false)

  // Tab changes also reset list selection/search (avoid effect chain on activeTab)
  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab)
    setSelectedItemIndex(0)
    setSearchQuery('')
  }, [])

  // Hooks
  const data = useNewWorktreeData(searchQuery, includeClosed)
  const targetServerId = data.selectedProject?.serverId
  const { data: preferences } = usePreferences(targetServerId)
  const { installedBackends } = useInstalledBackends({
    enabled: newWorktreeModalOpen,
    serverId: targetServerId,
  })

  // Resolve the project's git host provider for provider-aware auth + wording.
  const { data: providerInfo, isLoading: isProviderLoading } =
    useProjectGitProvider(data.selectedProject?.path)
  const provider = providerInfo?.provider ?? 'github'
  // Until the provider resolves it defaults to `github`; auth-error UI must wait
  // for this so a GitLab project never flashes the GitHub sign-in prompt.
  const providerResolved = !isProviderLoading
  const labels = providerLabels(provider)
  const triggerLogin = provider === 'gitlab' ? triggerGlabLogin : triggerGhLogin
  const isCliInstalled = provider === 'gitlab' ? isGlabInstalled : isGhInstalled
  // Security (Dependabot/advisories) and Discussions are GitHub-only; hide
  // them for GitLab.
  const githubOnlyTabsEnabled = provider !== 'gitlab'
  const displayTabs = TABS.filter(
    tab =>
      (tab.id !== 'security' && tab.id !== 'discussions') ||
      githubOnlyTabsEnabled
  ).map(tab =>
    tab.id === 'prs' ? { ...tab, label: labels.pullRequestsShort } : tab
  )
  // If the active tab was hidden (e.g. Security selected, then provider resolves
  // to GitLab), fall back to a safe default instead of a blank hidden tab.
  const activeTabAvailable = displayTabs.some(tab => tab.id === activeTab)

  // Existing worktrees/sessions per issue/PR/alert/Linear issue (duplicate guard)
  const { getMatches: getContextMatches } = useContextLinkUsage({
    enabled: newWorktreeModalOpen,
    projectId: data.selectedProjectId,
    projectPath: data.selectedProject?.path ?? null,
  })
  const startOnHost = useStartOnHost(data.selectedProject ?? null)
  const handlers = useNewWorktreeHandlers(
    data,
    {
      setActiveTab: handleTabChange,
      setSearchQuery,
      setSelectedItemIndex,
      setIncludeClosed,
    },
    {
      backend: investigationBackend,
      model: investigationModel,
      provider:
        investigationBackend !== 'claude' ||
        investigationProvider === '__anthropic__'
          ? null
          : investigationProvider,
      promptTemplate:
        preferences?.magic_prompts?.investigate_issue ??
        DEFAULT_INVESTIGATE_ISSUE_PROMPT,
    },
    getContextMatches,
    { run: startOnHost.run, hostId: startOnHost.hostId }
  )

  const handlePreviewIssue = (issue: { number: number; repo?: string }) => {
    previewOpenRef.current = true
    setPreviewItem({ type: 'issue', number: issue.number, repo: issue.repo })
  }

  const handlePreviewPR = (pr: { number: number; repo?: string }) => {
    previewOpenRef.current = true
    setPreviewItem({ type: 'pr', number: pr.number, repo: pr.repo })
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

  // With several remotes the quick actions are per-remote, so the "N" shortcut
  // targets the first one (origin) instead of the project default branch.
  const defaultBranch = data.selectedProject?.default_branch
  const primaryRemote = data.remotes?.[0]?.name
  const quickCreateBase =
    defaultBranch && (data.remotes?.length ?? 0) > 1 && primaryRemote
      ? `${primaryRemote}/${defaultBranch}`
      : undefined

  const { handleKeyDown } = useNewWorktreeKeyboard({
    activeTab,
    setActiveTab: handleTabChange,
    githubOnlyTabsEnabled,
    filteredIssues: data.filteredIssues,
    filteredPRs: data.filteredPRs,
    filteredSecurityAlerts: data.filteredSecurityAlerts,
    filteredBranches: data.filteredBranches,
    branchRemoteCount: data.branchRemoteCount,
    selectedItemIndex,
    setSelectedItemIndex,
    creatingFromNumber: handlers.creatingFromNumber,
    handleCreateWorktree: () =>
      handlers.handleCreateWorktree(undefined, quickCreateBase),
    handleBaseSession: handlers.handleBaseSession,
    handleSelectIssue: handlers.handleSelectIssue,
    handleSelectIssueAndInvestigate: handlers.handleSelectIssueAndInvestigate,
    handlePreviewIssue,
    handleSelectPR: handlers.handleSelectPR,
    handleSelectPRAndInvestigate: handlers.handleSelectPRAndInvestigate,
    handlePreviewPR,
    handleSelectSecurityAlert: handlers.handleSelectSecurityAlert,
    handleSelectSecurityAlertAndInvestigate:
      handlers.handleSelectSecurityAlertAndInvestigate,
    handlePreviewSecurityAlert,
    filteredAdvisories: data.filteredAdvisories,
    handleSelectAdvisory: handlers.handleSelectAdvisory,
    handleSelectAdvisoryAndInvestigate:
      handlers.handleSelectAdvisoryAndInvestigate,
    handlePreviewAdvisory,
    handleSelectBranch: handlers.handleSelectBranch,
    filteredLinearIssues: data.filteredLinearIssues,
    handleSelectLinearIssue: handlers.handleSelectLinearIssue,
    handleSelectLinearIssueAndInvestigate:
      handlers.handleSelectLinearIssueAndInvestigate,
    filteredSentryIssues: data.filteredSentryIssues,
    handleSelectSentryIssue: handlers.handleSelectSentryIssue,
    handleSelectSentryIssueAndInvestigate:
      handlers.handleSelectSentryIssueAndInvestigate,
    filteredDiscussions: data.filteredDiscussions,
    handleSelectDiscussion: handlers.handleSelectDiscussion,
  })

  // Reset to a safe tab when the current one is hidden (e.g. Security on GitLab).
  useEffect(() => {
    if (!activeTabAvailable) {
      handleTabChange('quick')
    }
  }, [activeTabAvailable, handleTabChange])

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

  const investigationKind = activeTab === 'prs' ? 'pr' : 'issue'
  const defaultInvestigationBackend =
    resolveMagicPromptBackend(
      preferences?.magic_prompt_backends,
      `investigate_${investigationKind}_backend`,
      data.selectedProject?.default_backend ?? preferences?.default_backend
    ) ?? 'claude'
  const defaultInvestigationProvider =
    defaultInvestigationBackend === 'claude'
      ? resolveMagicPromptProvider(
          preferences?.magic_prompt_providers,
          `investigate_${investigationKind}_provider`,
          preferences?.default_provider
        )
      : null
  const defaultInvestigationModel = resolveSelectedModelForBackend(
    defaultInvestigationBackend,
    preferences?.magic_prompt_models?.[
      `investigate_${investigationKind}_model`
    ],
    preferences
  )

  // Only relevant defaults reset selection, not favorites/fast-mode updates.
  useEffect(() => {
    if (
      !newWorktreeModalOpen ||
      (activeTab !== 'issues' && activeTab !== 'prs')
    )
      return
    setInvestigationBackend(defaultInvestigationBackend)
    setInvestigationProvider(defaultInvestigationProvider ?? '__anthropic__')
    setInvestigationModel(
      defaultInvestigationProvider &&
        !['opus', 'sonnet', 'haiku'].includes(defaultInvestigationModel)
        ? 'sonnet'
        : defaultInvestigationModel
    )
  }, [
    newWorktreeModalOpen,
    activeTab,
    defaultInvestigationBackend,
    defaultInvestigationProvider,
    defaultInvestigationModel,
  ])

  // Focus search input when switching to searchable tabs
  useEffect(() => {
    if (
      (activeTab === 'issues' ||
        activeTab === 'prs' ||
        activeTab === 'security' ||
        activeTab === 'branches' ||
        activeTab === 'linear' ||
        activeTab === 'sentry' ||
        activeTab === 'discussions') &&
      newWorktreeModalOpen
    ) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [activeTab, newWorktreeModalOpen])

  return (
    <>
      <Dialog
        open={newWorktreeModalOpen}
        onOpenChange={open => {
          console.log('[DIALOG-DEBUG] Parent onOpenChange', {
            open,
            previewItem: !!previewItem,
            previewOpenRef: previewOpenRef.current,
          })
          if (!open && (previewItem || previewOpenRef.current)) return
          handlers.handleOpenChange(open)
        }}
      >
        <DialogContent
          className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 flex flex-col overflow-hidden"
          onKeyDown={handleKeyDown}
          onEscapeKeyDown={e => {
            console.log('[DIALOG-DEBUG] Parent onEscapeKeyDown', {
              previewItem: !!previewItem,
              previewOpenRef: previewOpenRef.current,
            })
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
          onPointerDownOutside={e => {
            console.log('[DIALOG-DEBUG] Parent onPointerDownOutside', {
              previewItem: !!previewItem,
              previewOpenRef: previewOpenRef.current,
              target: (e.target as HTMLElement)?.tagName,
            })
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
          onInteractOutside={e => {
            console.log('[DIALOG-DEBUG] Parent onInteractOutside', {
              previewItem: !!previewItem,
              previewOpenRef: previewOpenRef.current,
              type: e.type,
            })
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
          onFocusOutside={e => {
            console.log('[DIALOG-DEBUG] Parent onFocusOutside', {
              previewItem: !!previewItem,
              previewOpenRef: previewOpenRef.current,
            })
            if (previewItem || previewOpenRef.current) e.preventDefault()
          }}
        >
          <DialogHeader className="px-4 pt-5 pb-2">
            <DialogTitle>
              New Session for {data.selectedProject?.name ?? 'Project'}
            </DialogTitle>
            <div className="pt-2">
              <StartOnHostPicker
                value={startOnHost.hostId}
                onChange={startOnHost.setHostId}
                disabled={startOnHost.phase !== 'idle'}
              />
            </div>
          </DialogHeader>

          {/* Tabs */}
          <SessionTabBar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            tabs={displayTabs}
          />

          {(activeTab === 'issues' || activeTab === 'prs') && (
            <div className="shrink-0 border-b border-border px-3 py-2 flex items-center gap-2">
              <span className="text-xs text-muted-foreground shrink-0">
                Investigate with
              </span>
              {newWorktreeModalOpen && (
                <DesktopBackendModelPicker
                  triggerClassName="!flex min-w-0 flex-1 max-w-full"
                  selectedBackend={investigationBackend}
                  selectedModel={investigationModel}
                  selectedProvider={
                    investigationBackend === 'claude' &&
                    investigationProvider !== '__anthropic__'
                      ? investigationProvider
                      : null
                  }
                  installedBackends={installedBackends}
                  customCliProfiles={preferences?.custom_cli_profiles ?? []}
                  onProviderChange={provider => {
                    setInvestigationBackend('claude')
                    setInvestigationProvider(provider)
                    setInvestigationModel(
                      provider === '__anthropic__'
                        ? resolveSelectedModelForBackend(
                            'claude',
                            undefined,
                            preferences
                          )
                        : 'sonnet'
                    )
                  }}
                  onModelChange={setInvestigationModel}
                  onBackendModelChange={(backend, model) => {
                    setInvestigationBackend(backend)
                    setInvestigationModel(model)
                    if (backend !== 'claude')
                      setInvestigationProvider('__anthropic__')
                  }}
                />
              )}
            </div>
          )}

          {/* Tab content */}
          <div className="flex-1 min-h-0 flex flex-col">
            {activeTab === 'quick' && (
              <QuickActionsTab
                hasBaseSession={data.hasBaseSession}
                onCreateWorktree={handlers.handleCreateWorktree}
                onBaseSession={handlers.handleBaseSession}
                isCreating={
                  data.createWorktree.isPending ||
                  data.createBaseSession.isPending
                }
                projectId={data.selectedProjectId}
                jeanConfig={data.jeanConfig}
                remotes={data.remotes}
                projectPath={data.selectedProject?.path}
                defaultBranch={defaultBranch}
                branches={data.branches}
                isLoadingBranches={data.isLoadingBranches}
              />
            )}

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
                onSelectIssue={handlers.handleSelectIssue}
                onInvestigateIssue={handlers.handleSelectIssueAndInvestigate}
                onBulkInvestigateIssues={handlers.handleBulkInvestigateIssues}
                onPreviewIssue={handlePreviewIssue}
                creatingFromNumber={handlers.creatingFromNumber}
                creatingFromRepo={handlers.creatingFromRepo}
                showSource={data.showGitHubSource}
                hasMultipleGitHubRemotes={data.hasMultipleGitHubRemotes}
                primaryGitHubRemote={data.primaryGitHubRemote}
                isBulkInvestigating={handlers.isBulkInvestigating}
                searchInputRef={searchInputRef}
                onLogin={triggerLogin}
                isCliInstalled={isCliInstalled}
                provider={provider}
                providerResolved={providerResolved}
                getContextMatches={getContextMatches}
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
                onSelectPR={handlers.handleSelectPR}
                onInvestigatePR={handlers.handleSelectPRAndInvestigate}
                onBulkInvestigatePRs={handlers.handleBulkInvestigatePRs}
                onStackPR={handlers.handleStackOnPR}
                onPreviewPR={handlePreviewPR}
                creatingFromNumber={handlers.creatingFromNumber}
                creatingFromRepo={handlers.creatingFromRepo}
                stackingFromPR={handlers.stackingFromPR}
                stackingFromRepo={handlers.stackingFromRepo}
                showSource={data.showGitHubSource}
                hasMultipleGitHubRemotes={data.hasMultipleGitHubRemotes}
                primaryGitHubRemote={data.primaryGitHubRemote}
                isBulkInvestigating={handlers.isBulkInvestigating}
                searchInputRef={searchInputRef}
                onLogin={triggerLogin}
                isCliInstalled={isCliInstalled}
                provider={provider}
                providerResolved={providerResolved}
                getContextMatches={getContextMatches}
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
                onSelectAlert={handlers.handleSelectSecurityAlert}
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
                onSelectAdvisory={handlers.handleSelectAdvisory}
                onInvestigateAdvisory={
                  handlers.handleSelectAdvisoryAndInvestigate
                }
                onPreviewAdvisory={handlePreviewAdvisory}
                creatingFromGhsaId={handlers.creatingFromGhsaId}
                onBulkInvestigateSecurity={
                  handlers.handleBulkInvestigateSecurity
                }
                isBulkInvestigating={handlers.isBulkInvestigating}
                getContextMatches={getContextMatches}
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
                onSelectIssue={handlers.handleSelectLinearIssue}
                onInvestigateIssue={
                  handlers.handleSelectLinearIssueAndInvestigate
                }
                onBulkInvestigateIssues={
                  handlers.handleBulkInvestigateLinearIssues
                }
                creatingFromId={handlers.creatingFromLinearId}
                isBulkInvestigating={handlers.isBulkInvestigating}
                searchInputRef={searchInputRef}
                getContextMatches={getContextMatches}
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
                onSelectIssue={handlers.handleSelectSentryIssue}
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

            {activeTab === 'discussions' && (
              <GitHubDiscussionsTab
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                includeClosed={includeClosed}
                setIncludeClosed={setIncludeClosed}
                discussions={data.filteredDiscussions}
                isLoading={data.isLoadingDiscussions}
                isRefetching={data.isRefetchingDiscussions}
                isSearching={data.isSearchingDiscussions}
                error={data.discussionsError}
                onRefresh={() => data.refetchDiscussions()}
                hasMore={!searchQuery.trim() && data.hasMoreDiscussions}
                isLoadingMore={data.isLoadingMoreDiscussions}
                onLoadMore={() => void data.fetchMoreDiscussions()}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectDiscussion={handlers.handleSelectDiscussion}
                creatingFromNumber={handlers.creatingFromNumber}
                searchInputRef={searchInputRef}
                onLogin={triggerGhLogin}
                isGhInstalled={isGhInstalled}
                getContextMatches={getContextMatches}
              />
            )}

            {activeTab === 'branches' && (
              <BranchesTab
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                branches={data.filteredBranches}
                remoteCount={data.branchRemoteCount}
                isLoading={data.isLoadingBranches}
                isRefetching={data.isRefetchingBranches}
                error={data.branchesError}
                onRefresh={() => data.refetchBranches()}
                selectedIndex={selectedItemIndex}
                setSelectedIndex={setSelectedItemIndex}
                onSelectBranch={handlers.handleSelectBranch}
                creatingFromBranch={handlers.creatingFromBranch}
                searchInputRef={searchInputRef}
              />
            )}
          </div>

          {/* Background open hint */}
          {activeTab !== 'quick' && !isMobile && (
            <div className="shrink-0 border-t border-border px-3 py-1.5">
              <span className="text-xs text-muted-foreground">
                Hold{' '}
                <Kbd className="mx-0.5 h-5 min-w-5 px-1 text-[10px]">
                  {getModifierSymbol()}
                </Kbd>{' '}
                to open in background
              </span>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {previewItem && data.selectedProject && (
        <IssuePreviewModal
          open={!!previewItem}
          onOpenChange={open => {
            if (!open) {
              console.log(
                '[DIALOG-DEBUG] Preview closing — setting previewOpenRef=true, clearing after rAF'
              )
              previewOpenRef.current = true
              setPreviewItem(null)
              // Clear ref after the current event cycle so parent guards still block
              requestAnimationFrame(() => {
                previewOpenRef.current = false
                console.log('[DIALOG-DEBUG] previewOpenRef cleared')
              })
            }
          }}
          projectPath={data.selectedProject.path}
          type={previewItem.type}
          number={previewItem.number}
          ghsaId={previewItem.ghsaId}
          repo={previewItem.repo}
        />
      )}
    </>
  )
}

export default NewWorktreeModal
