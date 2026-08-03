import { useCallback, useEffect, useRef, useState } from 'react'
import { getModifierSymbol } from '@/lib/platform'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  Zap,
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
import { IssuePreviewModal } from './IssuePreviewModal'

export type TabId =
  | 'quick'
  | 'issues'
  | 'prs'
  | 'security'
  | 'branches'
  | 'linear'
  | 'sentry'

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

export function NewWorktreeModal() {
  const { triggerLogin: triggerGhLogin, isGhInstalled } = useGhLogin()
  const { newWorktreeModalOpen } = useUIStore()
  const isMobile = useIsMobile()

  // Local state
  const [activeTab, setActiveTab] = useState<TabId>('quick')
  const [searchQuery, setSearchQuery] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [selectedItemIndex, setSelectedItemIndex] = useState(0)
  const [previewItem, setPreviewItem] = useState<{
    type: 'issue' | 'pr' | 'security' | 'advisory'
    number: number
    ghsaId?: string
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
  const handlers = useNewWorktreeHandlers(data, {
    setActiveTab: handleTabChange,
    setSearchQuery,
    setSelectedItemIndex,
    setIncludeClosed,
  })

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
    filteredIssues: data.filteredIssues,
    filteredPRs: data.filteredPRs,
    filteredSecurityAlerts: data.filteredSecurityAlerts,
    filteredBranches: data.filteredBranches,
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
          className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[90vw] sm:!max-w-[90vw] sm:!h-[85vh] sm:!max-h-[85vh] sm:!rounded-lg p-0 flex flex-col overflow-hidden"
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
          </DialogHeader>

          {/* Tabs */}
          <SessionTabBar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            tabs={TABS}
          />

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
                onSelectPR={handlers.handleSelectPR}
                onInvestigatePR={handlers.handleSelectPRAndInvestigate}
                onBulkInvestigatePRs={handlers.handleBulkInvestigatePRs}
                onStackPR={handlers.handleStackOnPR}
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
                <kbd className="mx-0.5 rounded bg-muted px-1 py-0.5 text-[10px]">
                  {getModifierSymbol()}
                </kbd>{' '}
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
        />
      )}
    </>
  )
}

export default NewWorktreeModal
