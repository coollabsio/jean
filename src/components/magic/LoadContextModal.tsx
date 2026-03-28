import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getModifierSymbol } from '@/lib/platform'
import {
  Bookmark,
  CircleDot,
  FolderOpen,
  GitPullRequest,
  Shield,
  ShieldAlert,
} from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { LucideIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { usePreferences } from '@/services/preferences'
import { useGhLogin } from '@/hooks/useGhLogin'
import { IssuePreviewModal } from '@/components/worktree/IssuePreviewModal'
import { githubQueryKeys } from '@/services/github'
import { linearQueryKeys } from '@/services/linear'
import { GitHubItemsTab } from './GitHubItemsTab'
import { SecurityAlertsTab } from './SecurityAlertsTab'
import { LinearItemsTab } from './LinearItemsTab'
import { ContextsTab } from './ContextsTab'
import { useLoadContextData } from './hooks/useLoadContextData'
import { useLoadContextHandlers } from './hooks/useLoadContextHandlers'
import { useLoadContextKeyboard } from './hooks/useLoadContextKeyboard'

type TabId = 'issues' | 'prs' | 'security' | 'contexts' | 'linear'

interface Tab {
  id: TabId
  label: string
  key: string
  icon: LucideIcon
}

const TABS: Tab[] = [
  { id: 'contexts', label: 'Contexts', key: '1', icon: Bookmark },
  { id: 'issues', label: 'Issues', key: '2', icon: CircleDot },
  { id: 'prs', label: 'PRs', key: '3', icon: GitPullRequest },
  { id: 'security', label: 'Security', key: '4', icon: Shield },
  { id: 'linear', label: 'Linear', key: '5', icon: LinearIcon },
]

interface LoadContextModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreeId: string | null
  worktreePath: string | null
  activeSessionId: string | null
  projectName: string
  projectId: string | null
}

export function LoadContextModal({
  open,
  onOpenChange,
  worktreeId,
  worktreePath,
  activeSessionId,
  projectName: _projectName,
  projectId,
}: LoadContextModalProps) {
  const queryClient = useQueryClient()
  const { triggerLogin: triggerGhLogin, isGhInstalled } = useGhLogin()
  const { data: preferences } = usePreferences()

  // Navigation state
  const [activeTab, setActiveTab] = useState<TabId>('issues')
  const [searchQuery, setSearchQuery] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Data layer
  const data = useLoadContextData({
    open,
    worktreePath,
    worktreeId,
    projectId,
    activeSessionId,
    searchQuery,
    includeClosed,
  })

  // Stable callback for handlers to reset search/selection
  const onClearSearch = useCallback(() => {
    setSearchQuery('')
    setSelectedIndex(0)
  }, [])

  // Handlers layer
  const handlers = useLoadContextHandlers({
    activeSessionId,
    worktreePath,
    worktreeId,
    projectId,
    refetchIssueContexts: data.refetchIssueContexts,
    refetchPRContexts: data.refetchPRContexts,
    refetchSecurityContexts: data.refetchSecurityContexts,
    refetchAdvisoryContexts: data.refetchAdvisoryContexts,
    refetchAttachedContexts: data.refetchAttachedContexts,
    refetchLinearContexts: data.refetchLinearContexts,
    refetchContexts: data.refetchContexts,
    renameMutation: data.renameMutation,
    preferences,
    onClearSearch,
  })

  // Keyboard navigation
  const { handleKeyDown } = useLoadContextKeyboard({
    activeTab,
    filteredIssues: data.filteredIssues,
    filteredPRs: data.filteredPRs,
    filteredSecurityAlerts: data.filteredSecurityAlerts,
    filteredAdvisories: data.filteredAdvisories,
    filteredLinearIssues: data.filteredLinearIssues,
    filteredContexts: data.filteredContexts,
    filteredEntries: data.filteredEntries,
    selectedIndex,
    setSelectedIndex,
    onSelectIssue: handlers.handleSelectIssue,
    onSelectPR: handlers.handleSelectPR,
    onSelectSecurityAlert: handlers.handleSelectSecurityAlert,
    onPreviewIssue: handlers.handlePreviewIssue,
    onPreviewPR: handlers.handlePreviewPR,
    onPreviewSecurityAlert: handlers.handlePreviewSecurityAlert,
    onSelectAdvisory: handlers.handleSelectAdvisory,
    onPreviewAdvisory: handlers.handlePreviewAdvisory,
    onSelectLinearIssue: handlers.handleSelectLinearIssue,
    onAttachContext: handlers.handleAttachContext,
    onSessionClick: handlers.handleSessionClick,
    onTabChange: setActiveTab,
  })

  // Track the previous open state to detect when modal opens
  const prevOpenRef = useRef(false)

  // Determine default tab and reset state when modal opens/closes
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      // Dynamic default tab based on loaded data
      if (data.hasLoadedIssueContexts) {
        setActiveTab('issues')
      } else if (data.hasLoadedPRContexts) {
        setActiveTab('prs')
      } else if (
        data.hasLoadedSecurityContexts ||
        data.hasLoadedAdvisoryContexts
      ) {
        setActiveTab('security')
      } else if (data.hasLoadedLinearContexts) {
        setActiveTab('linear')
      } else {
        setActiveTab('contexts')
      }

      setSearchQuery('')
      setIncludeClosed(false)
      setSelectedIndex(0)
      handlers.resetState()

      // Invalidate caches to fetch fresh data
      if (worktreePath) {
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.issues(worktreePath, 'open'),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.issues(worktreePath, 'all'),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.prs(worktreePath, 'open'),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.prs(worktreePath, 'all'),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.securityAlerts(worktreePath, 'open'),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.securityAlerts(worktreePath, 'all'),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.advisories(worktreePath, 'all'),
        })
      }
      if (activeSessionId) {
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.loadedContexts(activeSessionId),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.loadedPrContexts(activeSessionId),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.attachedContexts(activeSessionId),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.loadedSecurityContexts(activeSessionId),
        })
        queryClient.invalidateQueries({
          queryKey: githubQueryKeys.loadedAdvisoryContexts(activeSessionId),
        })
        queryClient.invalidateQueries({
          queryKey: linearQueryKeys.loadedContexts(activeSessionId),
        })
      }
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: linearQueryKeys.issues(projectId),
        })
      }
      queryClient.invalidateQueries({ queryKey: ['session-context'] })
    }

    // When modal closes, invalidate loaded context queries so the toolbar refreshes
    if (!open && prevOpenRef.current && activeSessionId) {
      queryClient.invalidateQueries({
        queryKey: githubQueryKeys.loadedContexts(activeSessionId),
      })
      queryClient.invalidateQueries({
        queryKey: githubQueryKeys.loadedPrContexts(activeSessionId),
      })
      queryClient.invalidateQueries({
        queryKey: githubQueryKeys.attachedContexts(activeSessionId),
      })
      queryClient.invalidateQueries({
        queryKey: githubQueryKeys.loadedSecurityContexts(activeSessionId),
      })
      queryClient.invalidateQueries({
        queryKey: githubQueryKeys.loadedAdvisoryContexts(activeSessionId),
      })
      queryClient.invalidateQueries({
        queryKey: linearQueryKeys.loadedContexts(activeSessionId),
      })
    }

    prevOpenRef.current = open
  }, [
    open,
    worktreePath,
    activeSessionId,
    projectId,
    queryClient,
    data.hasLoadedIssueContexts,
    data.hasLoadedPRContexts,
    data.hasLoadedSecurityContexts,
    data.hasLoadedAdvisoryContexts,
    data.hasLoadedLinearContexts,
    data.hasAttachedContexts,
    handlers.resetState,
  ])

  // Focus search input when tab changes
  useEffect(() => {
    if (open) {
      searchInputRef.current?.focus()
    }
  }, [open, activeTab])

  // Reset selection and search when switching tabs
  useEffect(() => {
    setSelectedIndex(0)
    setSearchQuery('')
  }, [activeTab])

  // Focus edit input when editing starts
  useEffect(() => {
    if (handlers.editingFilename && handlers.editInputRef.current) {
      handlers.editInputRef.current.focus()
      handlers.editInputRef.current.select()
    }
  }, [handlers.editingFilename])

  // Clear editing state when modal closes
  useEffect(() => {
    if (!open) {
      handlers.resetState()
    }
  }, [open, handlers.resetState])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 !w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[calc(100vh-4rem)] sm:!rounded-xl font-sans flex flex-col"
        onOpenAutoFocus={e => {
          e.preventDefault()
          searchInputRef.current?.focus()
        }}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="px-4 pt-5 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            Load Context
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex overflow-x-auto border-b border-border scrollbar-hide">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              tabIndex={-1}
              className={cn(
                'flex-1 px-4 py-2 text-sm font-medium transition-colors',
                'flex items-center justify-center gap-1.5',
                'hover:bg-accent focus:outline-none',
                'border-b-2',
                activeTab === tab.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground'
              )}
            >
              <tab.icon className="h-4 w-4" />
              <span className="text-xs sm:text-sm">{tab.label}</span>
              <kbd className="hidden sm:inline ml-0.5 text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">
                {getModifierSymbol()}+{tab.key}
              </kbd>
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex flex-col flex-1 min-h-0">
          {activeTab === 'issues' && (
            <GitHubItemsTab
              config={{
                kind: 'issues',
                loadedContexts: data.loadedIssueContexts ?? [],
                filteredItems: data.filteredIssues,
                onSelectItem: handlers.handleSelectIssue,
                onViewItem: handlers.handleViewIssue,
                onPreviewItem: handlers.handlePreviewIssue,
                onRemoveItem: handlers.handleRemoveIssue,
                onLoadItem: (num, refresh) =>
                  handlers.handleLoadIssue(num, refresh),
              }}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              includeClosed={includeClosed}
              setIncludeClosed={setIncludeClosed}
              searchInputRef={searchInputRef}
              isLoadingContexts={data.isLoadingIssueContexts}
              isLoading={data.isLoadingIssues}
              isRefetching={data.isRefetchingIssues}
              isSearching={data.isSearchingIssues}
              error={data.issuesError}
              onRefresh={() => data.refetchIssues()}
              selectedIndex={selectedIndex}
              setSelectedIndex={setSelectedIndex}
              loadingNumbers={handlers.loadingNumbers}
              removingNumbers={handlers.removingNumbers}
              hasLoadedContexts={data.hasLoadedIssueContexts}
              onGhLogin={triggerGhLogin}
              isGhInstalled={isGhInstalled}
            />
          )}

          {activeTab === 'prs' && (
            <GitHubItemsTab
              config={{
                kind: 'prs',
                loadedContexts: data.loadedPRContexts ?? [],
                filteredItems: data.filteredPRs,
                onSelectItem: handlers.handleSelectPR,
                onViewItem: handlers.handleViewPR,
                onPreviewItem: handlers.handlePreviewPR,
                onRemoveItem: handlers.handleRemovePR,
                onLoadItem: (num, refresh) =>
                  handlers.handleLoadPR(num, refresh),
              }}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              includeClosed={includeClosed}
              setIncludeClosed={setIncludeClosed}
              searchInputRef={searchInputRef}
              isLoadingContexts={data.isLoadingPRContexts}
              isLoading={data.isLoadingPRs}
              isRefetching={data.isRefetchingPRs}
              isSearching={data.isSearchingPRs}
              error={data.prsError}
              onRefresh={() => data.refetchPRs()}
              selectedIndex={selectedIndex}
              setSelectedIndex={setSelectedIndex}
              loadingNumbers={handlers.loadingNumbers}
              removingNumbers={handlers.removingNumbers}
              hasLoadedContexts={data.hasLoadedPRContexts}
              onGhLogin={triggerGhLogin}
              isGhInstalled={isGhInstalled}
            />
          )}

          {activeTab === 'security' && (
            <SecurityAlertsTab
              loadedContexts={data.loadedSecurityContexts ?? []}
              filteredAlerts={data.filteredSecurityAlerts}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              includeClosed={includeClosed}
              setIncludeClosed={setIncludeClosed}
              searchInputRef={searchInputRef}
              isLoadingContexts={data.isLoadingSecurityContexts}
              isLoading={data.isLoadingSecurityAlerts}
              isRefetching={data.isRefetchingSecurityAlerts}
              error={data.securityError}
              onRefresh={() => {
                data.refetchSecurityAlerts()
                data.refetchAdvisories()
              }}
              selectedIndex={selectedIndex}
              setSelectedIndex={setSelectedIndex}
              loadingNumbers={handlers.loadingNumbers}
              removingNumbers={handlers.removingNumbers}
              hasLoadedContexts={data.hasLoadedSecurityContexts}
              onSelectAlert={handlers.handleSelectSecurityAlert}
              onViewAlert={handlers.handleViewSecurityAlert}
              onPreviewAlert={handlers.handlePreviewSecurityAlert}
              onRemoveAlert={handlers.handleRemoveSecurityAlert}
              onLoadAlert={(num, refresh) =>
                handlers.handleLoadSecurityAlert(num, refresh)
              }
              onGhLogin={triggerGhLogin}
              isGhInstalled={isGhInstalled}
              // Advisory props
              loadedAdvisoryContexts={data.loadedAdvisoryContexts}
              filteredAdvisories={data.filteredAdvisories}
              isLoadingAdvisories={data.isLoadingAdvisories}
              isRefetchingAdvisories={data.isRefetchingAdvisories}
              hasLoadedAdvisoryContexts={data.hasLoadedAdvisoryContexts}
              isLoadingAdvisoryContexts={data.isLoadingAdvisoryContexts}
              loadingAdvisoryGhsaIds={handlers.loadingAdvisoryGhsaIds}
              removingAdvisoryGhsaIds={handlers.removingAdvisoryGhsaIds}
              onSelectAdvisory={handlers.handleSelectAdvisory}
              onViewAdvisory={handlers.handleViewAdvisory}
              onPreviewAdvisory={handlers.handlePreviewAdvisory}
              onRemoveAdvisory={handlers.handleRemoveAdvisory}
              onLoadAdvisory={(ghsaId, refresh) =>
                handlers.handleLoadAdvisory(ghsaId, refresh)
              }
            />
          )}

          {activeTab === 'linear' && (
            <LinearItemsTab
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              searchInputRef={searchInputRef}
              loadedContexts={data.loadedLinearContexts ?? []}
              isLoadingContexts={data.isLoadingLinearContexts}
              hasLoadedContexts={data.hasLoadedLinearContexts}
              loadingLinearIds={handlers.loadingLinearIds}
              removingLinearIds={handlers.removingLinearIds}
              onViewLoaded={handlers.handleViewLinearIssue}
              onRemoveLoaded={handlers.handleRemoveLinearIssue}
              onRefreshLoaded={(issueId, identifier) =>
                handlers.handleLoadLinearIssue(issueId, identifier, true)
              }
              filteredIssues={data.filteredLinearIssues}
              isLoading={data.isLoadingLinearIssues}
              isRefetching={data.isRefetchingLinearIssues}
              isSearching={data.isSearchingLinearIssues}
              error={data.linearIssuesError}
              onRefresh={() => data.refetchLinearIssues()}
              selectedIndex={selectedIndex}
              setSelectedIndex={setSelectedIndex}
              onSelectIssue={handlers.handleSelectLinearIssue}
            />
          )}

          {activeTab === 'contexts' && (
            <ContextsTab
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              searchInputRef={searchInputRef}
              attachedContexts={data.attachedSavedContexts ?? []}
              isLoadingAttachedContexts={data.isLoadingAttachedContexts}
              hasAttachedContexts={data.hasAttachedContexts}
              loadingSlugs={handlers.loadingSlugs}
              removingSlugs={handlers.removingSlugs}
              onViewAttachedContext={handlers.handleViewAttachedContext}
              onRemoveAttachedContext={handlers.handleRemoveAttachedContext}
              filteredContexts={data.filteredContexts}
              filteredEntries={data.filteredEntries}
              isLoading={data.isLoadingContexts || data.isLoadingSessions}
              error={data.contextsError}
              hasContexts={data.hasContexts}
              hasSessions={data.hasSessions}
              selectedIndex={selectedIndex}
              setSelectedIndex={setSelectedIndex}
              editingFilename={handlers.editingFilename}
              editValue={handlers.editValue}
              setEditValue={handlers.setEditValue}
              editInputRef={handlers.editInputRef}
              generatingSessionId={handlers.generatingSessionId}
              onAttachContext={handlers.handleAttachContext}
              onViewContext={(e, ctx) => {
                e.stopPropagation()
                handlers.handleViewContext(ctx)
              }}
              onStartEdit={handlers.handleStartEdit}
              onRenameSubmit={handlers.handleRenameSubmit}
              onRenameKeyDown={handlers.handleRenameKeyDown}
              onDeleteContext={handlers.handleDeleteContext}
              onSessionClick={handlers.handleSessionClick}
            />
          )}
        </div>

        {/* GitHub issue/PR preview modal */}
        {handlers.viewingContext &&
          (handlers.viewingContext.type === 'issue' ||
            handlers.viewingContext.type === 'pr') &&
          handlers.viewingContext.number &&
          worktreePath && (
            <IssuePreviewModal
              open={true}
              onOpenChange={open => {
                if (!open) handlers.setViewingContext(null)
              }}
              projectPath={worktreePath}
              type={handlers.viewingContext.type}
              number={handlers.viewingContext.number}
            />
          )}

        {/* Security/Advisory/Saved context viewer modal */}
        {handlers.viewingContext &&
          (handlers.viewingContext.type === 'saved' ||
            handlers.viewingContext.type === 'security' ||
            handlers.viewingContext.type === 'advisory') && (
            <Dialog
              open={true}
              onOpenChange={() => handlers.setViewingContext(null)}
            >
              <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-8rem)] sm:!max-w-[calc(100vw-8rem)] sm:!h-[calc(100vh-8rem)] sm:!rounded-lg flex flex-col">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    {handlers.viewingContext.type === 'security' ? (
                      <Shield className="h-4 w-4 text-orange-500" />
                    ) : handlers.viewingContext.type === 'advisory' ? (
                      <ShieldAlert className="h-4 w-4 text-orange-500" />
                    ) : (
                      <FolderOpen className="h-4 w-4 text-blue-500" />
                    )}
                    {handlers.viewingContext.title}
                  </DialogTitle>
                </DialogHeader>
                <ScrollArea className="flex-1 min-h-0">
                  <Markdown className="p-4">
                    {handlers.viewingContext.content}
                  </Markdown>
                </ScrollArea>
              </DialogContent>
            </Dialog>
          )}
      </DialogContent>
    </Dialog>
  )
}

export default LoadContextModal
