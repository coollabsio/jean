import { useEffect, useRef, useState } from 'react'
import { getModifierSymbol } from '@/lib/platform'
import {
  Zap,
  CircleDot,
  GitPullRequest,
  Shield,
  GitBranch,
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
import { IssuePreviewModal } from './IssuePreviewModal'
import { ExistingWorktreeDialog } from './ExistingWorktreeDialog'
import type { DetectedProjectWorktree } from '@/types/projects'

export type TabId = 'quick' | 'issues' | 'prs' | 'security' | 'branches' | 'linear'

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
]

export function NewWorktreeModal() {
  const { triggerLogin: triggerGhLogin, isGhInstalled } = useGhLogin()
  const { newWorktreeModalOpen } = useUIStore()

  // Local state
  const [activeTab, setActiveTab] = useState<TabId>('quick')
  const [searchQuery, setSearchQuery] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [selectedItemIndex, setSelectedItemIndex] = useState(0)
  const [existingWorktreeDialogOpen, setExistingWorktreeDialogOpen] =
    useState(false)
  const [previewItem, setPreviewItem] = useState<{
    type: 'issue' | 'pr' | 'security' | 'advisory'
    number: number
    ghsaId?: string
  } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Hooks
  const data = useNewWorktreeData(searchQuery, includeClosed)
  const handlers = useNewWorktreeHandlers(data, {
    setActiveTab,
    setSearchQuery,
    setSelectedItemIndex,
    setIncludeClosed,
  })

  const handlePreviewIssue = (issue: { number: number }) => {
    setPreviewItem({ type: 'issue', number: issue.number })
  }

  const handlePreviewPR = (pr: { number: number }) => {
    setPreviewItem({ type: 'pr', number: pr.number })
  }

  const handlePreviewSecurityAlert = (alert: { number: number }) => {
    setPreviewItem({ type: 'security', number: alert.number })
  }

  const handlePreviewAdvisory = (advisory: { ghsaId: string }) => {
    // Advisories use ghsaId as identifier; we pass number=0 since it's not number-based
    setPreviewItem({ type: 'advisory', number: 0, ghsaId: advisory.ghsaId })
  }

  const { handleKeyDown } = useNewWorktreeKeyboard({
    activeTab,
    setActiveTab,
    filteredIssues: data.filteredIssues,
    filteredPRs: data.filteredPRs,
    filteredSecurityAlerts: data.filteredSecurityAlerts,
    filteredBranches: data.filteredBranches,
    selectedItemIndex,
    setSelectedItemIndex,
    creatingFromNumber: handlers.creatingFromNumber,
    handleCreateWorktree: handlers.handleCreateWorktree,
    handleBaseSession: handlers.handleBaseSession,
    handleImportWorktree: () => setExistingWorktreeDialogOpen(true),
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
  })

  // Apply store-provided default tab when modal opens
  useEffect(() => {
    if (newWorktreeModalOpen) {
      const { newWorktreeModalDefaultTab, setNewWorktreeModalDefaultTab } =
        useUIStore.getState()
      if (newWorktreeModalDefaultTab) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setActiveTab(newWorktreeModalDefaultTab)
        setNewWorktreeModalDefaultTab(null)
      }
    }
  }, [newWorktreeModalOpen])

  // Focus search input when switching to searchable tabs
  useEffect(() => {
    if (
      (activeTab === 'issues' ||
        activeTab === 'prs' ||
        activeTab === 'security' ||
        activeTab === 'branches' ||
        activeTab === 'linear') &&
      newWorktreeModalOpen
    ) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [activeTab, newWorktreeModalOpen])

  // Reset selection when switching tabs
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedItemIndex(0)
    setSearchQuery('')
  }, [activeTab])

  return (
    <Dialog
      open={newWorktreeModalOpen}
      onOpenChange={handlers.handleOpenChange}
    >
      <DialogContent
        className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[90vw] sm:!max-w-[90vw] sm:!h-[85vh] sm:!max-h-[85vh] sm:!rounded-lg p-0 flex flex-col overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="px-4 pt-5 pb-2">
          <DialogTitle>
            New Session for {data.selectedProject?.name ?? 'Project'}
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <SessionTabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tabs={TABS}
        />

        {/* Tab content */}
        <div className="flex-1 min-h-0 flex flex-col">
          {activeTab === 'quick' && (
            <QuickActionsTab
              hasBaseSession={data.hasBaseSession}
              onCreateWorktree={handlers.handleCreateWorktree}
              onBaseSession={handlers.handleBaseSession}
              onImportWorktree={() => setExistingWorktreeDialogOpen(true)}
              isCreating={
                data.createWorktree.isPending ||
                data.createBaseSession.isPending
              }
              isImporting={handlers.isImportingWorktree}
              projectId={data.selectedProjectId}
              jeanConfig={data.jeanConfig}
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
              onPreviewIssue={handlePreviewIssue}
              creatingFromNumber={handlers.creatingFromNumber}
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
              onPreviewPR={handlePreviewPR}
              creatingFromNumber={handlers.creatingFromNumber}
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
              onInvestigateIssue={handlers.handleSelectLinearIssueAndInvestigate}
              creatingFromId={handlers.creatingFromLinearId}
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
        {activeTab !== 'quick' && (
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
      {previewItem && data.selectedProject && (
        <IssuePreviewModal
          open={!!previewItem}
          onOpenChange={open => {
            if (!open) setPreviewItem(null)
          }}
          projectPath={data.selectedProject.path}
          type={previewItem.type}
          number={previewItem.number}
          ghsaId={previewItem.ghsaId}
        />
      )}
      <ExistingWorktreeDialog
        open={existingWorktreeDialogOpen}
        onOpenChange={setExistingWorktreeDialogOpen}
        projectId={data.selectedProjectId}
        isOpening={handlers.isImportingWorktree}
        onSelect={async (worktree: DetectedProjectWorktree) => {
          try {
            await handlers.handleOpenDetectedWorktree(worktree)
            setExistingWorktreeDialogOpen(false)
          } catch {
            // keep selector open on failure
          }
        }}
      />
    </Dialog>
  )
}

export default NewWorktreeModal
