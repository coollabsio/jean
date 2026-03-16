import { useCallback, useEffect } from 'react'
import type { TabId } from '../NewWorktreeModal'
import type {
  GitHubIssue,
  GitHubPullRequest,
  DependabotAlert,
  RepositoryAdvisory,
} from '@/types/github'
import type { LinearIssue } from '@/types/linear'

interface Params {
  activeTab: TabId
  setActiveTab: (tab: TabId) => void
  filteredIssues: GitHubIssue[]
  filteredPRs: GitHubPullRequest[]
  filteredSecurityAlerts: DependabotAlert[]
  filteredBranches: string[]
  selectedItemIndex: number
  setSelectedItemIndex: (i: number | ((prev: number) => number)) => void
  creatingFromNumber: number | null
  handleCreateWorktree: () => void
  handleBaseSession: () => void
  handleSelectIssue: (issue: GitHubIssue, background?: boolean) => void
  handleSelectIssueAndInvestigate: (
    issue: GitHubIssue,
    background?: boolean
  ) => void
  handlePreviewIssue: (issue: GitHubIssue) => void
  handleSelectPR: (pr: GitHubPullRequest, background?: boolean) => void
  handleSelectPRAndInvestigate: (
    pr: GitHubPullRequest,
    background?: boolean
  ) => void
  handlePreviewPR: (pr: GitHubPullRequest) => void
  handleSelectSecurityAlert: (
    alert: DependabotAlert,
    background?: boolean
  ) => void
  handleSelectSecurityAlertAndInvestigate: (
    alert: DependabotAlert,
    background?: boolean
  ) => void
  handlePreviewSecurityAlert: (alert: DependabotAlert) => void
  filteredAdvisories: RepositoryAdvisory[]
  handleSelectAdvisory: (
    advisory: RepositoryAdvisory,
    background?: boolean
  ) => void
  handleSelectAdvisoryAndInvestigate: (
    advisory: RepositoryAdvisory,
    background?: boolean
  ) => void
  handlePreviewAdvisory: (advisory: RepositoryAdvisory) => void
  handleSelectBranch: (branchName: string, background?: boolean) => void
  filteredLinearIssues: LinearIssue[]
  handleSelectLinearIssue: (issue: LinearIssue, background?: boolean) => void
  handleSelectLinearIssueAndInvestigate: (
    issue: LinearIssue,
    background?: boolean
  ) => void
}

export function useNewWorktreeKeyboard({
  activeTab,
  setActiveTab,
  filteredIssues,
  filteredPRs,
  filteredSecurityAlerts,
  filteredBranches,
  selectedItemIndex,
  setSelectedItemIndex,
  creatingFromNumber,
  handleCreateWorktree,
  handleBaseSession,
  handleSelectIssue,
  handleSelectIssueAndInvestigate,
  handlePreviewIssue,
  handleSelectPR,
  handleSelectPRAndInvestigate,
  handlePreviewPR,
  handleSelectSecurityAlert,
  handleSelectSecurityAlertAndInvestigate,
  handlePreviewSecurityAlert,
  filteredAdvisories,
  handleSelectAdvisory,
  handleSelectAdvisoryAndInvestigate,
  handlePreviewAdvisory,
  handleSelectBranch,
  filteredLinearIssues,
  handleSelectLinearIssue,
  handleSelectLinearIssueAndInvestigate,
}: Params) {
  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = document.querySelector(
      `[data-item-index="${selectedItemIndex}"]`
    )
    selectedElement?.scrollIntoView({ block: 'nearest' })
  }, [selectedItemIndex])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = e.key.toLowerCase()

      // Tab shortcuts (Cmd+key)
      if (e.metaKey || e.ctrlKey) {
        if (key === '1') {
          e.preventDefault()
          setActiveTab('quick')
          return
        }
        if (key === '2') {
          e.preventDefault()
          setActiveTab('issues')
          return
        }
        if (key === '3') {
          e.preventDefault()
          setActiveTab('prs')
          return
        }
        if (key === '4') {
          e.preventDefault()
          setActiveTab('security')
          return
        }
        if (key === '5') {
          e.preventDefault()
          setActiveTab('branches')
          return
        }
        if (key === '6') {
          e.preventDefault()
          setActiveTab('linear')
          return
        }
      }

      // Quick actions shortcuts
      if (activeTab === 'quick') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          if (key === 'n') {
            e.preventDefault()
            e.nativeEvent.stopImmediatePropagation()
            handleCreateWorktree()
            return
          }
          if (key === 'm') {
            e.preventDefault()
            e.nativeEvent.stopImmediatePropagation()
            handleBaseSession()
            return
          }
        }
      }

      // Issues tab navigation
      if (activeTab === 'issues' && filteredIssues.length > 0) {
        if (key === 'arrowdown') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) =>
            Math.min(prev + 1, filteredIssues.length - 1)
          )
          return
        }
        if (key === 'arrowup') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) => Math.max(prev - 1, 0))
          return
        }
        if (key === 'enter' && filteredIssues[selectedItemIndex]) {
          e.preventDefault()
          handleSelectIssue(filteredIssues[selectedItemIndex], e.metaKey)
          return
        }
        if (
          key === 'o' &&
          (e.metaKey || e.ctrlKey) &&
          filteredIssues[selectedItemIndex]
        ) {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          handlePreviewIssue(filteredIssues[selectedItemIndex])
          return
        }
        if (
          key === 'm' &&
          (e.metaKey || e.ctrlKey) &&
          filteredIssues[selectedItemIndex] &&
          creatingFromNumber === null
        ) {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          handleSelectIssueAndInvestigate(
            filteredIssues[selectedItemIndex],
            e.metaKey || e.ctrlKey
          )
          return
        }
      }

      // PRs tab navigation
      if (activeTab === 'prs' && filteredPRs.length > 0) {
        if (key === 'arrowdown') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) =>
            Math.min(prev + 1, filteredPRs.length - 1)
          )
          return
        }
        if (key === 'arrowup') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) => Math.max(prev - 1, 0))
          return
        }
        if (key === 'enter' && filteredPRs[selectedItemIndex]) {
          e.preventDefault()
          handleSelectPR(filteredPRs[selectedItemIndex], e.metaKey)
          return
        }
        if (
          key === 'o' &&
          (e.metaKey || e.ctrlKey) &&
          filteredPRs[selectedItemIndex]
        ) {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          handlePreviewPR(filteredPRs[selectedItemIndex])
          return
        }
        if (
          key === 'm' &&
          (e.metaKey || e.ctrlKey) &&
          filteredPRs[selectedItemIndex] &&
          creatingFromNumber === null
        ) {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          handleSelectPRAndInvestigate(
            filteredPRs[selectedItemIndex],
            e.metaKey || e.ctrlKey
          )
          return
        }
      }

      // Security tab navigation (Dependabot alerts + Repository advisories)
      const totalSecurityItems =
        filteredSecurityAlerts.length + filteredAdvisories.length
      if (activeTab === 'security' && totalSecurityItems > 0) {
        if (key === 'arrowdown') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) =>
            Math.min(prev + 1, totalSecurityItems - 1)
          )
          return
        }
        if (key === 'arrowup') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) => Math.max(prev - 1, 0))
          return
        }
        if (key === 'enter') {
          e.preventDefault()
          if (selectedItemIndex < filteredSecurityAlerts.length) {
            const alert = filteredSecurityAlerts[selectedItemIndex]
            if (alert) handleSelectSecurityAlert(alert, e.metaKey)
          } else {
            const advisory =
              filteredAdvisories[
                selectedItemIndex - filteredSecurityAlerts.length
              ]
            if (advisory) handleSelectAdvisory(advisory, e.metaKey)
          }
          return
        }
        if (key === 'o' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          if (selectedItemIndex < filteredSecurityAlerts.length) {
            const alert = filteredSecurityAlerts[selectedItemIndex]
            if (alert) handlePreviewSecurityAlert(alert)
          } else {
            const advisory =
              filteredAdvisories[
                selectedItemIndex - filteredSecurityAlerts.length
              ]
            if (advisory) handlePreviewAdvisory(advisory)
          }
          return
        }
        if (
          key === 'm' &&
          (e.metaKey || e.ctrlKey) &&
          creatingFromNumber === null
        ) {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          if (selectedItemIndex < filteredSecurityAlerts.length) {
            const alert = filteredSecurityAlerts[selectedItemIndex]
            if (alert)
              handleSelectSecurityAlertAndInvestigate(
                alert,
                e.metaKey || e.ctrlKey
              )
          } else {
            const advisory =
              filteredAdvisories[
                selectedItemIndex - filteredSecurityAlerts.length
              ]
            if (advisory)
              handleSelectAdvisoryAndInvestigate(
                advisory,
                e.metaKey || e.ctrlKey
              )
          }
          return
        }
      }

      // Linear tab navigation
      if (activeTab === 'linear' && filteredLinearIssues.length > 0) {
        if (key === 'arrowdown') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) =>
            Math.min(prev + 1, filteredLinearIssues.length - 1)
          )
          return
        }
        if (key === 'arrowup') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) => Math.max(prev - 1, 0))
          return
        }
        if (key === 'enter' && filteredLinearIssues[selectedItemIndex]) {
          e.preventDefault()
          handleSelectLinearIssue(
            filteredLinearIssues[selectedItemIndex],
            e.metaKey
          )
          return
        }
        if (
          key === 'm' &&
          (e.metaKey || e.ctrlKey) &&
          filteredLinearIssues[selectedItemIndex]
        ) {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          handleSelectLinearIssueAndInvestigate(
            filteredLinearIssues[selectedItemIndex],
            e.metaKey || e.ctrlKey
          )
          return
        }
      }

      // Branches tab navigation
      if (activeTab === 'branches' && filteredBranches.length > 0) {
        if (key === 'arrowdown') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) =>
            Math.min(prev + 1, filteredBranches.length - 1)
          )
          return
        }
        if (key === 'arrowup') {
          e.preventDefault()
          setSelectedItemIndex((prev: number) => Math.max(prev - 1, 0))
          return
        }
        if (key === 'enter' && filteredBranches[selectedItemIndex]) {
          e.preventDefault()
          handleSelectBranch(filteredBranches[selectedItemIndex], e.metaKey)
          return
        }
      }
    },
    [
      activeTab,
      filteredIssues,
      filteredPRs,
      filteredSecurityAlerts,
      filteredAdvisories,
      filteredBranches,
      selectedItemIndex,
      handleCreateWorktree,
      handleBaseSession,
      handleSelectIssue,
      handleSelectIssueAndInvestigate,
      handlePreviewIssue,
      handleSelectPR,
      handleSelectPRAndInvestigate,
      handlePreviewPR,
      handleSelectSecurityAlert,
      handleSelectSecurityAlertAndInvestigate,
      handlePreviewSecurityAlert,
      handleSelectAdvisory,
      handleSelectAdvisoryAndInvestigate,
      handlePreviewAdvisory,
      handleSelectBranch,
      filteredLinearIssues,
      handleSelectLinearIssue,
      handleSelectLinearIssueAndInvestigate,
      creatingFromNumber,
      setActiveTab,
      setSelectedItemIndex,
    ]
  )

  return { handleKeyDown }
}
