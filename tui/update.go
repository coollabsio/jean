package tui

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/coollabsio/jean/config"
	"github.com/coollabsio/jean/git"
	"github.com/coollabsio/jean/github"
)

// debugLog writes a message to the debug log file if debug logging is enabled
func (m Model) debugLog(msg string) {
	// Check if debug logging is enabled in config
	if m.configManager == nil || !m.configManager.GetDebugLoggingEnabled() {
		return
	}
	if f, err := os.OpenFile("/tmp/jean-debug.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
		fmt.Fprintf(f, "%s\n", msg)
		f.Close()
	}
}

// Update handles all state updates
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.ready = true
		return m, nil

	case tea.KeyMsg:
		// Modal is open - handle modal input
		if m.modal != noModal {
			return m.handleModalInput(msg)
		}

		// Normal mode - handle main UI input
		return m.handleMainInput(msg)

	case worktreesLoadedMsg:
		if msg.err != nil {
			m.debugLog(fmt.Sprintf("Failed to load worktrees: %v", msg.err))
			cmd = m.showErrorNotification("Failed to load worktrees", 4*time.Second)
			return m, cmd
		} else {
			m.debugLog(fmt.Sprintf("Worktrees loaded: %d worktrees (lightweight mode)", len(msg.worktrees)))
			for i, wt := range msg.worktrees {
				m.debugLog(fmt.Sprintf("  [%d] %s - HasUncommitted: %v", i, wt.Branch, wt.HasUncommitted))
			}
			m.worktrees = msg.worktrees

			// Mark initialization as complete after first successful worktree load
			m.isInitializing = false

			// Load PRs from config for each worktree
			for i := range m.worktrees {
				if m.configManager != nil {
					prs := m.configManager.GetPRs(m.repoPath, m.worktrees[i].Branch)
					m.debugLog(fmt.Sprintf("  Loaded %d PRs for branch %s", len(prs), m.worktrees[i].Branch))
					if len(prs) > 0 {
						for _, pr := range prs {
							m.debugLog(fmt.Sprintf("    PR: %s (Status: %s)", pr.URL, pr.Status))
						}
					}
					m.worktrees[i].PRs = prs
				}
			}

		// Sort worktrees before restoring cursor position
		// This ensures cursor is positioned correctly in the sorted list
		m.sortWorktrees()

			// If we just created a worktree, select it
			if m.lastCreatedBranch != "" {
				for i, wt := range m.worktrees {
					if wt.Branch == m.lastCreatedBranch {
						m.selectedIndex = i
						// Clear the flag
						m.lastCreatedBranch = ""
						break
					}
				}
			} else {
				// Otherwise, restore last selected branch if available
				if m.configManager != nil {
					if lastBranch := m.configManager.GetLastSelectedBranch(m.repoPath); lastBranch != "" {
						// Find the worktree with this branch
						for i, wt := range m.worktrees {
							if wt.Branch == lastBranch {
								m.selectedIndex = i
								break
							}
						}
					}
				}
			}

			// Launch background status loaders for each worktree (non-blocking)
			// This enables progressive status updates as each worktree's data loads
			statusLoaders := make([]tea.Cmd, 0, len(m.worktrees))
			for i := range m.worktrees {
				statusLoaders = append(statusLoaders, m.loadWorktreeStatus(i, m.worktrees[i]))
			}
			if len(statusLoaders) > 0 {
				cmd = tea.Batch(statusLoaders...)
			} else {
				cmd = nil
			}
		}
		// After first successful worktree load, check if we need to show onboarding
		return m, tea.Batch(cmd, m.checkOnboardingStatus())

	case worktreeStatusUpdatedMsg:
		// Update individual worktree with loaded status data (no blocking, progressive update)
		if msg.index >= 0 && msg.index < len(m.worktrees) {
			m.worktrees[msg.index].HasUncommitted = msg.hasUncommitted
			m.worktrees[msg.index].AheadCount = msg.aheadCount
			m.worktrees[msg.index].BehindCount = msg.behindCount
			m.worktrees[msg.index].IsOutdated = msg.behindCount > 0
		}
		return m, nil

	case onboardingStatusMsg:
		// If user needs onboarding and we haven't shown it yet, show the modal
		if msg.needsOnboarding {
			m.modal = onboardingModal
			m.onboardingFocused = 0 // Focus on "Install" button by default
		}
		return m, nil

	case branchesLoadedMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to load branches", 4*time.Second)
			return m, cmd
		} else {
			m.branches = msg.branches
		}
		return m, nil

	case prsLoadedMsg:
		if msg.err != nil {
			m.debugLog("prsLoadedMsg handler: ERROR - " + msg.err.Error())
			m.prLoadingError = msg.err.Error()
			cmd = m.showErrorNotification("Failed to load PRs: "+msg.err.Error(), 4*time.Second)
			return m, cmd
		} else {
			m.debugLog(fmt.Sprintf("prsLoadedMsg handler: SUCCESS - loaded %d PRs, filtering and preparing modal", len(msg.prs)))
			m.prs = msg.prs
			m.filteredPRs = msg.prs
			m.prListIndex = 0
			m.prLoadingError = ""
			m.debugLog(fmt.Sprintf("prsLoadedMsg handler: filteredPRs set to %d items, prListIndex=0", len(m.filteredPRs)))
		}
		return m, nil

	case prDetailsLoadedForBranchMsg:
		if msg.err != nil {
			// Silently ignore errors - PR lookup failure is not critical
			m.debugLog(fmt.Sprintf("prDetailsLoadedForBranchMsg handler: ERROR for branch %s - %s", msg.branch, msg.err.Error()))
			return m, nil
		}

		if msg.prURL == "" {
			// No PR found for this branch - not an error, just nothing to do
			m.debugLog(fmt.Sprintf("prDetailsLoadedForBranchMsg handler: No PR found for branch %s", msg.branch))
			return m, nil
		}

		// PR found - save to config and reload worktrees
		m.debugLog(fmt.Sprintf("prDetailsLoadedForBranchMsg handler: SUCCESS - found PR for branch %s: %s", msg.branch, msg.prURL))
		if m.configManager != nil {
			if err := m.configManager.AddPR(m.repoPath, msg.branch, msg.prURL, msg.prNumber, msg.title, msg.author); err != nil {
				m.debugLog(fmt.Sprintf("prDetailsLoadedForBranchMsg handler: Failed to save PR to config: %s", err.Error()))
			} else {
				m.debugLog("prDetailsLoadedForBranchMsg handler: PR saved to config successfully")
			}
		}

		// Reload worktrees to display the updated PR info
		return m, m.loadWorktrees()

	case worktreeCreatedMsg:
		if msg.err != nil {
			// Check if this is a setup script error (warning) or a git error (error)
			errMsg := msg.err.Error()
			if strings.Contains(errMsg, "setup script failed") {
				// Setup script failed - show warning but worktree was created
				// Extract just the relevant error message (skip "setup script failed: " prefix)
				warningMsg := strings.TrimPrefix(errMsg, "setup script failed: ")
				cmd = m.showWarningNotification(fmt.Sprintf("Worktree created but setup script failed:\n%s", warningMsg))
				m.modal = noModal
				m.lastCreatedBranch = msg.branch
				// Still refresh worktrees since the worktree was created successfully
				return m, tea.Batch(cmd, m.loadWorktrees())
			} else {
				// Git worktree creation failed - show error
				cmd = m.showErrorNotification("Failed to create worktree", 4*time.Second)
				return m, cmd
			}
		} else {
			cmd = m.showSuccessNotification("Worktree created successfully", 3*time.Second)
			m.modal = noModal

			// Store the newly created branch name for selection after reload
			m.lastCreatedBranch = msg.branch

			// Store PR info if worktree was created from PR
			if m.pendingPRInfo != nil && m.configManager != nil {
				pr := m.pendingPRInfo
				m.debugLog(fmt.Sprintf("worktreeCreatedMsg: saving PR info - PR #%d (%s) for branch %s to config", pr.Number, pr.Title, msg.branch))
				if err := m.configManager.AddPR(m.repoPath, msg.branch, pr.URL, pr.Number, pr.Title, pr.Author.Login); err != nil {
					m.debugLog(fmt.Sprintf("worktreeCreatedMsg: failed to store PR info: %v", err))
				} else {
					m.debugLog(fmt.Sprintf("worktreeCreatedMsg: PR info stored successfully"))
				}
				m.pendingPRInfo = nil // Clear after storing
			}

			// Quick refresh without expensive status checks
			// Also load PR details asynchronously for the newly created branch
			return m, tea.Batch(
				cmd,
				m.loadWorktrees(),
				m.loadPRDetailsForBranch(msg.path, msg.branch),
			)
		}

	case worktreeCreatedWithSessionMsg:
		if msg.err != nil {
			// Check if this is a setup script error (warning) or a git error (error)
			errMsg := msg.err.Error()
			if strings.Contains(errMsg, "setup script failed") {
				// Setup script failed - show warning but worktree was created
				warningMsg := strings.TrimPrefix(errMsg, "setup script failed: ")
				cmd = m.showWarningNotification(fmt.Sprintf("Worktree created but setup script failed:\n%s", warningMsg))
				m.modal = noModal
				m.lastCreatedBranch = msg.branch
				// Store session name for switch
				m.switchInfo = SwitchInfo{
					Path:       msg.path,
					Branch:     msg.branch,
					SessionName: msg.sessionName,
					AutoClaude: m.autoClaude,
				}
				return m, tea.Batch(cmd, m.loadWorktrees())
			} else {
				// Git worktree creation failed - show error
				cmd = m.showErrorNotification("Failed to create worktree", 4*time.Second)
				return m, cmd
			}
		} else {
			cmd = m.showSuccessNotification("Worktree created successfully", 3*time.Second)
			m.modal = noModal

			// Store the newly created branch name for selection after reload
			m.lastCreatedBranch = msg.branch

			// Store session name for switch
			m.switchInfo = SwitchInfo{
				Path:        msg.path,
				Branch:      msg.branch,
				SessionName: msg.sessionName,
				AutoClaude:  m.autoClaude,
			}

			// Quick refresh without expensive status checks
			// Also load PR details asynchronously for the newly created branch
			return m, tea.Batch(
				cmd,
				m.loadWorktrees(),
				m.loadPRDetailsForBranch(msg.path, msg.branch),
			)
		}

	case worktreeDeletedMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to delete worktree", 4*time.Second)
			return m, cmd
		} else {
			cmd = m.showSuccessNotification("Worktree deleted successfully", 3*time.Second)
			m.modal = noModal
			if m.selectedIndex >= len(m.worktrees)-1 {
				m.selectedIndex = len(m.worktrees) - 2
				if m.selectedIndex < 0 {
					m.selectedIndex = 0
				}
			}
			// Quick refresh without expensive status checks
			return m, tea.Batch(
				cmd,
				m.loadWorktrees(),
			)
		}

	case branchRenamedMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to rename branch", 4*time.Second)
			return m, cmd
		} else {
			// Check if directory was renamed
			var notificationMsg string
			if msg.oldPath != msg.newPath {
				// Directory was renamed successfully
				oldDir := filepath.Base(msg.oldPath)
				newDir := filepath.Base(msg.newPath)
				notificationMsg = fmt.Sprintf("Branch renamed: %s → %s (%s → %s)",
					msg.oldBranch, msg.newBranch, oldDir, newDir)
			} else {
				// Only branch was renamed (not in workspace or move failed)
				notificationMsg = fmt.Sprintf("Branch renamed: %s → %s", msg.oldBranch, msg.newBranch)
			}

			cmd = m.showSuccessNotification(notificationMsg, 4*time.Second)
			// Rename tmux sessions to match the new branch name
			// Reload worktree list to update the UI
			return m, tea.Batch(
				cmd,
				m.renameSessionsForBranch(msg.oldBranch, msg.newBranch),
				m.loadWorktrees(),
			)
		}

	case branchCheckedOutMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to checkout branch", 4*time.Second)
			return m, cmd
		} else {
			cmd = m.showSuccessNotification("Branch checked out successfully", 3*time.Second)
			return m, cmd
		}

	case baseBranchLoadedMsg:
		m.baseBranch = msg.branch
		// Load worktrees with lightweight mode for instant UI appearance
		// Status data (uncommitted changes, ahead/behind counts) loads asynchronously in background
		// This dramatically improves perceived startup performance with many worktrees
		return m, m.loadWorktreesLightweight()

	case notificationHideMsg:
		// Only handle if this is the current notification
		if m.notification != nil && m.notification.ID == msg.id {
			m.notificationVisible = false
			return m, tea.Tick(300*time.Millisecond, func(t time.Time) tea.Msg {
				return notificationClearedMsg{id: msg.id}
			})
		}
		return m, nil

	case notificationClearedMsg:
		// Only clear if this is the current notification
		if m.notification != nil && m.notification.ID == msg.id {
			m.notification = nil
		}
		return m, nil

	case sessionsLoadedMsg:
		m.sessions = msg.sessions
		return m, nil

	case editorOpenedMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to open editor: " + msg.err.Error(), 4*time.Second)
			return m, cmd
		} else {
			cmd = m.showSuccessNotification("Opened in editor", 3*time.Second)
			return m, cmd
		}

	case gitRepoOpenedMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to open repository: " + msg.err.Error(), 4*time.Second)
			return m, cmd
		} else {
			cmd = m.showSuccessNotification("Opened in browser", 3*time.Second)
			return m, cmd
		}

	case prCreatedMsg:
		if msg.err != nil {
			m.debugLog(fmt.Sprintf("PR creation failed: %v", msg.err))
			errMsg := msg.err.Error()

			// Check if the error is "PR already exists"
			if strings.Contains(errMsg, "already exists") {
				// Only retry once - if we're already retrying, don't try again
				if !m.prRetryInProgress {
					// Check if AI is configured
					hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
					aiContentEnabled := m.configManager != nil && m.configManager.GetAICommitEnabled()

					if hasAPIKey && aiContentEnabled && msg.worktreePath != "" && msg.branch != "" {
						// Mark that we're in a retry attempt
						m.prRetryInProgress = true
						// Store the worktree and branch for retry
						m.prRetryWorktreePath = msg.worktreePath
						m.prRetryBranch = msg.branch

						// Trigger PR content regeneration
						cmd = m.showWarningNotification("PR already exists. Regenerating title and description...")
						return m, tea.Batch(cmd, m.generatePRContent(msg.worktreePath, msg.branch, m.baseBranch))
					}
				}
			}

			// Clear retry state before showing error
			m.prRetryInProgress = false
			m.prRetryWorktreePath = ""
			m.prRetryBranch = ""
			m.prRetryTitle = ""
			m.prRetryDescription = ""

			cmd = m.showErrorNotification("Failed to create PR: " + errMsg, 4*time.Second)
			return m, cmd
		} else {
			// Clear retry state on successful creation
			m.prRetryInProgress = false
			m.prRetryWorktreePath = ""
			m.prRetryBranch = ""
			m.prRetryTitle = ""
			m.prRetryDescription = ""

			m.debugLog(fmt.Sprintf("PR created successfully: %s", msg.prURL))
			// Find the worktree branch for this PR
			var prBranch string
			for _, wt := range m.worktrees {
				if wt.Path == msg.prURL || len(m.worktrees) == 1 {
					// Try to find the worktree by comparing with current selection
					if sel := m.selectedWorktree(); sel != nil && sel.Path == wt.Path {
						prBranch = wt.Branch
						break
					}
				}
			}

			// If we have a selected worktree, use its branch
			if prBranch == "" {
				if sel := m.selectedWorktree(); sel != nil {
					prBranch = sel.Branch
				}
			}

			m.debugLog(fmt.Sprintf("Saving PR for branch: %s, title: %s", prBranch, msg.prTitle))
			// Save PR to config
			if prBranch != "" {
				// Extract PR number from URL (e.g., github.com/owner/repo/pull/123)
				prNumber := 0
				if parts := strings.Split(msg.prURL, "/pull/"); len(parts) == 2 {
					fmt.Sscanf(parts[1], "%d", &prNumber)
				}
				m.debugLog(fmt.Sprintf("Extracted PR number: %d from URL: %s", prNumber, msg.prURL))
				_ = m.configManager.AddPR(m.repoPath, prBranch, msg.prURL, prNumber, msg.prTitle, msg.author)
			}

			m.debugLog("Triggering worktree refresh after PR creation")
			cmd = m.showSuccessNotification("PR created / updated: " + msg.prURL, 5*time.Second)
			return m, tea.Batch(
				cmd,
				m.loadWorktrees(),
			)
		}

	case prBranchNameGeneratedMsg:
		// AI branch name generated for PR
		if msg.err != nil {
			// AI generation failed - fall back to current name (graceful degradation)
			cmd = m.showWarningNotification("Using current branch name for PR...")
			// Still try to generate PR content with AI
			hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
			aiContentEnabled := m.configManager != nil && m.configManager.GetAICommitEnabled()
			if hasAPIKey && aiContentEnabled {
				return m, tea.Batch(cmd, m.generatePRContent(msg.worktreePath, msg.oldBranchName, m.baseBranch))
			}
			return m, tea.Batch(cmd, m.createPR(msg.worktreePath, msg.oldBranchName, "", ""))
		}

		// Check if target branch already exists locally
		targetExists, _ := m.gitManager.BranchExists(msg.worktreePath, msg.newBranchName)
		if targetExists {
			// Target branch already exists - skip rename and use current name for PR
			cmd = m.showWarningNotification("Branch name already exists, using current name...")
			// Still try to generate PR content with AI
			hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
			aiContentEnabled := m.configManager != nil && m.configManager.GetAICommitEnabled()
			if hasAPIKey && aiContentEnabled {
				return m, tea.Batch(cmd, m.generatePRContent(msg.worktreePath, msg.oldBranchName, m.baseBranch))
			}
			return m, tea.Batch(cmd, m.createPR(msg.worktreePath, msg.oldBranchName, "", ""))
		}

		// Store pending rename state
		m.pendingPRNewName = msg.newBranchName
		m.pendingPROldName = msg.oldBranchName
		m.pendingPRWorktree = msg.worktreePath

		// Check if remote branch exists
		remoteExists, _ := m.gitManager.RemoteBranchExists(msg.worktreePath, msg.oldBranchName)

		if remoteExists {
			// Delete remote branch first
			cmd = m.showInfoNotification("Deleting old remote branch...")
			return m, tea.Batch(cmd, m.deleteRemoteBranchForPR(msg.worktreePath, msg.oldBranchName, msg.newBranchName))
		} else {
			// No remote, go straight to rename
			cmd = m.showInfoNotification("Renaming to: " + msg.newBranchName)
			return m, tea.Batch(cmd, m.renameBranchForPR(msg.oldBranchName, msg.newBranchName, msg.worktreePath))
		}

	case prRemoteBranchDeletedMsg:
		// Remote branch deleted, now rename local branch
		if msg.err != nil {
			// Deletion failed but continue anyway
			cmd = m.showWarningNotification("Couldn't delete old remote, continuing...")
		}

		// Check if target branch already exists locally
		targetExists, _ := m.gitManager.BranchExists(msg.worktreePath, msg.newBranchName)
		if targetExists {
			// Target branch already exists - skip rename and use current name for PR
			cmd = m.showWarningNotification("Branch name already exists, using current name...")
			// Still try to generate PR content with AI
			hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
			aiContentEnabled := m.configManager != nil && m.configManager.GetAICommitEnabled()
			if hasAPIKey && aiContentEnabled {
				return m, tea.Batch(cmd, m.generatePRContent(msg.worktreePath, msg.oldBranchName, m.baseBranch))
			}
			return m, tea.Batch(cmd, m.createPR(msg.worktreePath, msg.oldBranchName, "", ""))
		}

		cmd = m.showInfoNotification("Renaming branch locally...")
		return m, tea.Batch(cmd, m.renameBranchForPR(msg.oldBranchName, msg.newBranchName, msg.worktreePath))

	case prBranchRenamedMsg:
		// Branch renamed, now create PR with new name
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to rename branch: " + msg.err.Error(), 4*time.Second)
			return m, cmd
		}

		// Rename succeeded, check if we should generate AI PR content
		hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
		aiEnabled := m.configManager != nil && m.configManager.GetAIBranchNameEnabled()

		if hasAPIKey && aiEnabled {
			// Generate AI PR content before creating PR
			cmd = m.showInfoNotification("🤖 Generating PR title and description...")
			return m, tea.Batch(
				cmd,
				m.renameSessionsForBranch(msg.oldBranchName, msg.newBranchName),
				m.generatePRContent(msg.worktreePath, msg.newBranchName, m.baseBranch),
			)
		} else {
			// No AI - open PR content modal for manual entry
			m.modal = prContentModal
			m.prModalFocused = 0
			m.prModalWorktreePath = msg.worktreePath
			m.prModalBranch = msg.newBranchName

			// Default title to new branch name
			defaultTitle := strings.ReplaceAll(msg.newBranchName, "-", " ")
			defaultTitle = strings.ReplaceAll(defaultTitle, "_", " ")
			defaultTitle = strings.Title(defaultTitle)
			m.prTitleInput.SetValue(defaultTitle)
			m.prTitleInput.Focus()
			m.prDescriptionInput.SetValue("")

			// Rename tmux sessions
			cmd = m.renameSessionsForBranch(msg.oldBranchName, msg.newBranchName)
			return m, cmd
		}

	case commitCreatedMsg:
		if msg.err != nil {
			m.debugLog(fmt.Sprintf("Commit creation failed: %v", msg.err))
			cmd = m.showErrorNotification("Failed to create commit: " + msg.err.Error(), 4*time.Second)
			return m, cmd
		} else {
			m.debugLog(fmt.Sprintf("Commit created successfully with hash: %s", msg.commitHash))
			// Clear commit modal inputs for next use
			m.commitSubjectInput.SetValue("")
			m.commitBodyInput.SetValue("")
			m.modalFocused = 0

			// Show success message with commit hash
			if msg.commitHash != "" {
				hashDisplay := msg.commitHash
				if len(msg.commitHash) > 8 {
					hashDisplay = msg.commitHash[:8]
				}
				cmd = m.showSuccessNotification("Commit created: " + hashDisplay, 3*time.Second)
			} else {
				cmd = m.showSuccessNotification("Commit created successfully", 3*time.Second)
			}

			// Check if we're committing before PR creation
			if m.commitBeforePR && m.prCreationPending != "" {
				// Get the branch name from the pending PR worktree
				var branch string
				for _, wt := range m.worktrees {
					if wt.Path == m.prCreationPending {
						branch = wt.Branch
						break
					}
				}

				// Reset commit before PR flag
				m.commitBeforePR = false

				// Check if we should do AI renaming
				hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
				aiEnabled := m.configManager != nil && m.configManager.GetAIBranchNameEnabled()
				isRandomName := m.gitManager.IsRandomBranchName(branch)
				shouldAIRename := hasAPIKey && aiEnabled && isRandomName

				if shouldAIRename {
					// Start AI rename flow before PR creation
					cmd = m.showInfoNotification("🤖 Generating semantic branch name...")
					return m, tea.Batch(cmd, m.generateBranchNameForPR(m.prCreationPending, branch, m.baseBranch))
				} else {
					// No AI rename needed - show PR type selection modal
					m.modal = prTypeModal
					m.prModalWorktreePath = m.prCreationPending
					m.prModalBranch = branch
					m.prTypeCursor = 1 // Default to "Ready for review"
					m.commitBeforePR = false
					m.prCreationPending = ""
					return m, m.showSuccessNotification("Committed successfully. Select PR type:", 2*time.Second)
				}
			}

			// Check if we're committing before push-only (no PR)
			if m.commitBeforePR && m.prCreationPending == "" {
				// Get current worktree
				wt := m.selectedWorktree()
				if wt == nil {
					return m, cmd
				}

				// Reset commit before PR flag
				m.commitBeforePR = false

				// Check if we should do AI renaming
				hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
				aiEnabled := m.configManager != nil && m.configManager.GetAIBranchNameEnabled()
				isRandomName := m.gitManager.IsRandomBranchName(wt.Branch)
				shouldAIRename := hasAPIKey && aiEnabled && isRandomName

				if shouldAIRename {
					// Start AI rename flow before push
					notifyCmd := m.showInfoNotification("🤖 Generating semantic branch name...")
					return m, tea.Batch(notifyCmd, m.generateBranchNameForPush(wt.Path, wt.Branch, m.baseBranch))
				} else {
					// No AI rename needed, go straight to push
					notifyCmd := m.showInfoNotification("Pushing to remote...")
					return m, tea.Batch(notifyCmd, m.pushBranch(wt.Path, wt.Branch))
				}
			}

			// Normal commit (not before PR)
			m.debugLog("Triggering worktree refresh after commit")
			return m, tea.Batch(
				cmd,
				m.loadWorktrees(),
			)
		}

	case autoCommitBeforePRMsg:
		// Auto-commit succeeded, now proceed with PR creation
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to commit changes: " + msg.err.Error(), 4*time.Second)
			return m, cmd
		}

		// Commit succeeded, now proceed with PR creation
		// Check if we should do AI renaming first
		hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
		aiEnabled := m.configManager != nil && m.configManager.GetAIBranchNameEnabled()
		isRandomName := m.gitManager.IsRandomBranchName(msg.branch)

		shouldAIRename := hasAPIKey && aiEnabled && isRandomName

		if shouldAIRename {
			// Start AI rename flow before PR creation
			cmd = m.showInfoNotification("🤖 Generating semantic branch name...")
			return m, tea.Batch(cmd, m.generateBranchNameForPR(msg.worktreePath, msg.branch, m.baseBranch))
		} else {
			// No AI rename needed - show PR type selection modal
			m.modal = prTypeModal
			m.prModalWorktreePath = msg.worktreePath
			m.prModalBranch = msg.branch
			m.prTypeCursor = 1 // Default to "Ready for review"
			return m, nil
		}

	case prContentGeneratedMsg:
		// AI PR content generated (title and description)

		// Stop spinner animation if we're generating in PR modal
		if m.modal == prContentModal {
			m.generatingPRContent = false
		}

		if msg.err != nil {
			// AI generation failed
			// Check if this was a retry attempt
			if m.prRetryWorktreePath != "" {
				m.prRetryInProgress = false
				m.prRetryWorktreePath = ""
				m.prRetryBranch = ""
				m.prRetryTitle = ""
				m.prRetryDescription = ""
				cmd = m.showErrorNotification("Failed to regenerate PR content: " + msg.err.Error(), 4*time.Second)
				return m, cmd
			}
			// AI generation failed - show error and keep modal open for manual entry
			cmd = m.showWarningNotification("Failed to generate PR content: " + msg.err.Error())
			return m, cmd
		}

		// Check if this is a PR retry attempt (PR already exists)
		if m.prRetryWorktreePath != "" {
			// Store the generated content and worktree/branch info before clearing
			retryWorktreePath := m.prRetryWorktreePath
			retryBranch := m.prRetryBranch
			// Clear retry state before returning
			m.prRetryInProgress = false
			m.prRetryWorktreePath = ""
			m.prRetryBranch = ""
			m.prRetryTitle = ""
			m.prRetryDescription = ""
			// Retry creating PR with new content (skip push since branch already exists)
			cmd = m.showInfoNotification("Retrying PR creation with new content...")
			return m, tea.Batch(cmd, m.createPRRetry(retryWorktreePath, retryBranch, msg.title, msg.description))
		}

		// Check if we're in PR content modal
		if m.modal == prContentModal {
			// Fill in the generated content but don't create PR yet - let user confirm
			m.prTitleInput.SetValue(msg.title)
			m.prDescriptionInput.SetValue(msg.description)
			cmd = m.showSuccessNotification("PR content generated! Review and press Enter to create", 3*time.Second)
			return m, cmd
		}

		// Not in modal - auto-create or update PR with generated content (for auto-generation flow)
		cmd = m.showInfoNotification("Creating or updating draft PR...")
		return m, tea.Batch(cmd, m.createOrUpdatePR(msg.worktreePath, msg.branch, msg.title, msg.description))

	case pushBranchNameGeneratedMsg:
		// AI branch name generated for push
		if msg.err != nil {
			// AI generation failed - fall back to current name (graceful degradation)
			cmd = m.showWarningNotification("Using current branch name...")
			return m, tea.Batch(cmd, m.pushBranch(msg.worktreePath, msg.oldBranchName))
		}

		// Check if target branch already exists locally
		targetExists, _ := m.gitManager.BranchExists(msg.worktreePath, msg.newBranchName)
		if targetExists {
			// Target branch already exists - skip rename and use current name for push
			cmd = m.showWarningNotification("Branch name already exists, using current name...")
			return m, tea.Batch(cmd, m.pushBranch(msg.worktreePath, msg.oldBranchName))
		}

		// Store pending rename state (reuse PR state variables)
		m.pendingPRNewName = msg.newBranchName
		m.pendingPROldName = msg.oldBranchName
		m.pendingPRWorktree = msg.worktreePath

		// Check if remote branch exists
		remoteExists, _ := m.gitManager.RemoteBranchExists(msg.worktreePath, msg.oldBranchName)

		if remoteExists {
			// Delete remote branch first
			cmd = m.showInfoNotification("Deleting old remote branch...")
			return m, tea.Batch(cmd, m.deleteRemoteBranchForPush(msg.worktreePath, msg.oldBranchName, msg.newBranchName))
		} else {
			// No remote, go straight to rename
			cmd = m.showInfoNotification("Renaming to: " + msg.newBranchName)
			return m, tea.Batch(cmd, m.renameBranchForPush(msg.oldBranchName, msg.newBranchName, msg.worktreePath))
		}

	case pushRemoteBranchDeletedMsg:
		// Remote branch deleted, now rename local branch
		if msg.err != nil {
			// Deletion failed but continue anyway
			cmd = m.showWarningNotification("Couldn't delete old remote, continuing...")
		}

		// Check if target branch already exists locally
		targetExists, _ := m.gitManager.BranchExists(msg.worktreePath, msg.newBranchName)
		if targetExists {
			// Target branch already exists - skip rename and use current name for push
			cmd = m.showWarningNotification("Branch name already exists, using current name...")
			return m, tea.Batch(cmd, m.pushBranch(msg.worktreePath, msg.oldBranchName))
		}

		cmd = m.showInfoNotification("Renaming branch locally...")
		return m, tea.Batch(cmd, m.renameBranchForPush(msg.oldBranchName, msg.newBranchName, msg.worktreePath))

	case pushBranchRenamedMsg:
		// Branch renamed, now push with new name
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to rename branch: " + msg.err.Error(), 4*time.Second)
			return m, cmd
		}

		// Rename succeeded, now push
		cmd = m.showInfoNotification("Pushing to remote...")
		return m, tea.Batch(
			cmd,
			m.renameSessionsForBranch(msg.oldBranchName, msg.newBranchName),
			m.pushBranch(msg.worktreePath, msg.newBranchName),
		)

	case pushCompletedMsg:
		// Push completed
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to push: " + msg.err.Error(), 4*time.Second)
			return m, cmd
		}

		// Push succeeded
		cmd = m.showSuccessNotification("Pushed to origin/"+msg.branch, 3*time.Second)
		return m, tea.Batch(
			cmd,
			m.loadWorktrees(),
		)

	case themeChangedMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to change theme: " + msg.err.Error(), 3*time.Second)
			return m, cmd
		} else {
			cmd = m.showSuccessNotification("Theme changed to: " + msg.theme, 2*time.Second)
			return m, cmd
		}

	case branchPulledMsg:
		if msg.err != nil {
			if msg.hadConflict {
				// Show error with abort option
				cmd = m.showWarningNotification("Merge conflict! Run 'git merge --abort' in the worktree to abort.")
				return m, cmd
			} else if strings.Contains(msg.err.Error(), "already up-to-date") {
				// User tried to pull but worktree is already up-to-date (after checking fresh refs)
				cmd = m.showInfoNotification("Worktree is already up-to-date with base branch")
				return m, cmd
			} else {
				cmd = m.showErrorNotification("Failed to pull from base branch: " + msg.err.Error(), 5*time.Second)
				return m, cmd
			}
		} else {
			cmd = m.showSuccessNotification("Successfully pulled changes from base branch", 3*time.Second)
			return m, tea.Batch(
				cmd,
				m.loadWorktrees(),
			)
		}

	case refreshWithPullMsg:
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to refresh: " + msg.err.Error(), 5*time.Second)
			return m, cmd
		} else {
			// Build detailed status message based on what was pulled
			statusMsg := buildRefreshStatusMessage(msg)

			// If there was an error pulling the main repo branch, append it to the message
			if msg.pullErr != nil {
				statusMsg += " (pull error: " + msg.pullErr.Error() + ")"
				cmd = m.showWarningNotification(statusMsg)
			} else {
				cmd = m.showSuccessNotification(statusMsg, 3*time.Second)
			}

			// Only show notification if not initializing (suppress during startup)
			if !m.isInitializing {
				cmd = m.showSuccessNotification(buildRefreshStatusMessage(msg), 3*time.Second)
			}
			// Reload worktree list to show updated status
			return m, tea.Batch(
				cmd,
				m.loadWorktrees(),
			)
		}

	case prStatusesRefreshedMsg:
		if msg.err != nil {
			// Silently handle PR status refresh errors
			return m, m.loadWorktrees()
		}
		// Reload worktrees to show updated PR statuses
		return m, m.loadWorktrees()

	case scriptOutputMsg:
		// Find and update the script execution with this name
		for i := range m.runningScripts {
			if m.runningScripts[i].name == msg.scriptName {
				m.runningScripts[i].output = msg.output
				m.runningScripts[i].finished = true
				break
			}
		}
		return m, nil

	case scriptOutputStreamMsg:
		// Update script with incremental output
		for i := range m.runningScripts {
			if m.runningScripts[i].name == msg.scriptName {
				// Append new output (don't replace)
				m.runningScripts[i].output += msg.output
				if msg.finished {
					m.runningScripts[i].finished = true
					// Clean up the shared buffer
					scriptBuffersMutex.Lock()
					delete(scriptOutputBuffers, i)
					scriptBuffersMutex.Unlock()
				}
				break
			}
		}
		return m, nil

	case scriptOutputPollMsg:
		// Check if buffer exists for this script
		scriptBuffersMutex.RLock()
		buf := scriptOutputBuffers[msg.scriptIdx]
		scriptBuffersMutex.RUnlock()

		if buf == nil {
			// Buffer doesn't exist, script might be done or not started
			return m, nil
		}

		// Get current output from buffer
		buf.mutex.Lock()
		currentOutput := buf.buffer.String()
		isFinished := buf.finished
		buf.mutex.Unlock()

		// Update the script's output
		if msg.scriptIdx < len(m.runningScripts) {
			m.runningScripts[msg.scriptIdx].output = currentOutput
			if isFinished {
				m.runningScripts[msg.scriptIdx].finished = true
				// Clean up the shared buffer
				scriptBuffersMutex.Lock()
				delete(scriptOutputBuffers, msg.scriptIdx)
				scriptBuffersMutex.Unlock()
				return m, nil // Stop polling when finished
			}
		}

		// Continue polling if not finished
		return m, m.pollScriptOutput(msg.scriptIdx)

	case activityTickMsg:
		// Check if enough time has passed since last activity check
		if time.Since(m.lastActivityCheck) >= m.activityCheckInterval {
			m.lastActivityCheck = time.Now()
			cmd = m.checkSessionActivity()
			return m, cmd
		}
		return m, m.scheduleActivityCheck()

	case activityCheckedMsg:
		if msg.err == nil {
			// Update sessions with activity information
			m.sessions = msg.sessions
		}
		// Continue scheduling activity checks
		cmd = m.scheduleActivityCheck()
		return m, cmd

	case versionCheckMsg:
		// Silently handle errors (don't show error notification for version check failures)
		if msg.err != nil {
			return m, nil
		}

		// Show notification only if update is available
		if msg.updateAvailable {
			notifMsg := fmt.Sprintf("Update available: %s → %s. Run: jean update", msg.currentVersion, msg.latestVersion)
			cmd = m.showInfoNotification(notifMsg)
			return m, cmd
		}
		return m, nil

	case commitMessageGeneratedMsg:
		m.generatingCommit = false // Stop spinner animation
		if msg.err != nil {
			// If auto-committing with AI, show error and abort
			if m.autoCommitWithAI {
				m.autoCommitWithAI = false
				cmd := m.showErrorNotification("🤖 Failed to generate commit message: " + msg.err.Error(), 4*time.Second)
				return m, cmd
			}
			// If in PR creation flow, show error and abort
			if m.commitBeforePR {
				m.commitBeforePR = false
				cmd := m.showErrorNotification("🤖 Failed to generate commit message: " + msg.err.Error(), 4*time.Second)
				return m, cmd
			}
			// Set status message in commit modal
			m.commitModalStatus = "❌ Error: " + msg.err.Error()
			m.commitModalStatusTime = time.Now()
			return m, nil
		} else {
			// If auto-committing with AI, commit immediately without PR flow
			if m.autoCommitWithAI {
				m.autoCommitWithAI = false
				if wt := m.selectedWorktree(); wt != nil {
					return m, m.createCommit(wt.Path, msg.subject, msg.body)
				}
				return m, nil
			}
			// If in PR creation flow, auto-commit with generated message
			if m.commitBeforePR {
				cmd := m.showInfoNotification("🤖 Committing with AI-generated message...")
				return m, tea.Batch(cmd, m.createCommit(m.prCreationPending, msg.subject, msg.body))
			}
			// Otherwise populate the commit message fields with AI-generated content for user review
			m.commitSubjectInput.SetValue(msg.subject)
			m.commitBodyInput.SetValue(msg.body)
			// Set success status message
			m.commitModalStatus = "✅ Message generated successfully - review and edit if needed"
			m.commitModalStatusTime = time.Now()
			// Move focus to subject input so user can review/edit
			m.modalFocused = 0
			m.commitSubjectInput.Focus()
			return m, nil
		}

	case apiKeyTestedMsg:
		if msg.err != nil {
			// Set status message in AI settings modal
			m.aiModalStatus = "❌ Test failed: " + msg.err.Error()
			m.aiModalStatusTime = time.Now()
			return m, nil
		} else {
			// Set success status message
			m.aiModalStatus = "✅ API key is valid and working!"
			m.aiModalStatusTime = time.Now()
			return m, nil
		}

	case aiPromptsLoadedMsg:
		// Load prompts into the modal inputs
		if msg.err != nil {
			m.aiPromptsStatus = "Error loading prompts: " + msg.err.Error()
			return m, nil
		}
		m.aiPromptCommitInput.SetValue(msg.commitPrompt)
		m.aiPromptBranchInput.SetValue(msg.branchPrompt)
		m.aiPromptPRInput.SetValue(msg.prPrompt)
		m.aiPromptsStatus = ""
		return m, nil

	case aiPromptsSavedMsg:
		if msg.err != nil {
			m.aiPromptsStatus = "❌ Failed to save: " + msg.err.Error()
			m.aiPromptsStatusTime = time.Now()
			return m, nil
		}
		// Success - close modal and return to AI settings
		cmd := m.showSuccessNotification("AI prompts saved successfully", 2*time.Second)
		m.modal = aiSettingsModal
		m.aiModalFocusedField = 0
		m.aiPromptCommitInput.Blur()
		m.aiPromptBranchInput.Blur()
		m.aiPromptPRInput.Blur()
		return m, cmd

	case aiPromptsResetMsg:
		if msg.err != nil {
			m.aiPromptsStatus = "❌ Failed to reset: " + msg.err.Error()
			m.aiPromptsStatusTime = time.Now()
			return m, nil
		}
		// Reload the default prompts to display them
		cmd := m.loadAIPrompts()
		m.aiPromptsStatus = "✅ Prompts reset to defaults"
		m.aiPromptsStatusTime = time.Now()
		return m, cmd

	case tmuxConfigInstalledMsg:
		if msg.err != nil {
			return m, m.showErrorNotification("Failed to install tmux config: "+msg.err.Error(), 4*time.Second)
		}
		// Mark onboarding as completed
		if err := m.configManager.SetOnboarded(); err != nil {
			m.debugLog(fmt.Sprintf("Failed to save onboarding status: %v", err))
		}
		m.modal = noModal
		return m, m.showSuccessNotification("✅ Tmux config installed! Restart tmux or run 'tmux source ~/.tmux.conf'", 4*time.Second)

	case prFetchedForCreationMsg:
		// Handle fetch completion before PR creation
		m.prFetchingForCreation = false
		if msg.err != nil {
			return m, m.showErrorNotification("Failed to fetch from remote: "+msg.err.Error(), 3*time.Second)
		}

		// Fetch successful, now proceed with PR creation flow
		if wt := m.selectedWorktree(); wt != nil {
			// Check if there are uncommitted changes
			hasUncommitted, err := m.gitManager.HasUncommittedChanges(wt.Path)
			if err != nil {
				return m, m.showErrorNotification("Failed to check for uncommitted changes: "+err.Error(), 3*time.Second)
			}

			// Check AI configuration
			hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
			aiEnabled := m.configManager != nil && m.configManager.GetAIBranchNameEnabled()
			aiContentEnabled := m.configManager != nil && m.configManager.GetAICommitEnabled()
			hasAI := hasAPIKey && (aiEnabled || aiContentEnabled)

			// If there are uncommitted changes, decide how to handle them
			if hasUncommitted {
				if hasAI && aiContentEnabled {
					// AI is enabled for commit messages - generate commit message with AI first
					cmd := m.showInfoNotification("🤖 Generating conventional commit message...")
					m.commitBeforePR = true
					m.prCreationPending = wt.Path // Set to trigger PR creation after commit
					return m, tea.Batch(cmd, m.generateCommitMessageWithAI(wt.Path))
				} else if hasAI {
					// AI is enabled for branch but not commit - auto-commit with simple message and proceed
					cmd := m.showInfoNotification("Committing changes...")
					m.commitBeforePR = true
					m.prCreationPending = wt.Path // Set to trigger PR creation after commit
					return m, tea.Batch(cmd, m.autoCommitBeforePR(wt.Path, wt.Branch))
				} else {
					// No AI - show commit modal for user to write proper commit message
					m.modal = commitModal
					m.modalFocused = 0
					m.commitSubjectInput.SetValue("")
					m.commitSubjectInput.Focus()
					m.commitBodyInput.SetValue("")
					m.commitBeforePR = true
					m.prCreationPending = wt.Path // Set to trigger PR creation after commit
					return m, nil
				}
			}

			// No uncommitted changes - proceed to PR creation
			// Check if we should do AI renaming first
			isRandomName := m.gitManager.IsRandomBranchName(wt.Branch)
			shouldAIRename := hasAPIKey && aiEnabled && isRandomName

			if shouldAIRename {
				// Start AI rename flow before PR creation
				cmd := m.showInfoNotification("🤖 Generating semantic branch name...")
				m.prCreationPending = wt.Path // Set to trigger PR creation after rename
				return m, tea.Batch(cmd, m.generateBranchNameForPush(wt.Path, wt.Branch, m.baseBranch))
			} else {
				// No AI rename needed - show PR type selection modal first
				m.modal = prTypeModal
				m.prModalWorktreePath = wt.Path
				m.prModalBranch = wt.Branch
				m.prTypeCursor = 1 // Default to "Ready for review"
				return m, nil
			}
		}

	case spinnerTickMsg:
		// Update spinner animation frame and schedule next tick if still generating
		if m.generatingCommit {
			m.spinnerFrame = (m.spinnerFrame + 1) % 10
			return m, m.animateSpinner()
		}
		if m.generatingPRContent {
			m.prSpinnerFrame = (m.prSpinnerFrame + 1) % 10
			return m, m.animateSpinner()
		}
		// No more spinners, return no command
		return m, nil

	case renameGeneratedMsg:
		// Stop spinner and handle rename generation result
		m.generatingRename = false
		if msg.err != nil {
			// Set error status message
			m.renameModalStatus = "❌ Error: " + msg.err.Error()
			m.renameModalStatusTime = time.Now()
		} else {
			// Populate the name input with AI-generated branch name
			m.nameInput.SetValue(msg.name)
			m.nameInput.CursorEnd()
			m.renameModalStatus = "✅ Generated from changes"
			m.renameModalStatusTime = time.Now()
		}
		return m, nil

	case renameSpinnerTickMsg:
		// Update spinner animation frame and schedule next tick if still generating
		if m.generatingRename {
			m.renameSpinnerFrame = (m.renameSpinnerFrame + 1) % 10
			return m, m.animateRenameSpinner()
		}
		return m, nil

	case worktreeEnsuredMsg:
		m.ensuringWorktree = false
		if msg.err != nil {
			cmd = m.showErrorNotification(fmt.Sprintf("Failed to ensure worktree exists: %v", msg.err), 4*time.Second)
			m.pendingSwitchInfo = nil
			return m, cmd
		}
		// Worktree is now ensured to exist, proceed with switch
		if m.pendingSwitchInfo != nil {
			m.switchInfo = *m.pendingSwitchInfo
			m.pendingSwitchInfo = nil
			return m, tea.Quit
		}

	case prMarkedReadyMsg:
		// PR has been marked as ready for review
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to mark PR as ready: "+msg.err.Error(), 4*time.Second)
			return m, cmd
		}

		// Now proceed with merge - get the stored merge method from merge strategy modal
		wt := m.selectedWorktree()
		if wt == nil {
			return m, m.showErrorNotification("No worktree selected", 3*time.Second)
		}

		// Get the PR info to find merge method (we need to reopen the modal to get this info)
		// For now, show success and reload
		prs, ok := wt.PRs.([]config.PRInfo)
		if !ok || len(prs) == 0 {
			cmd = m.showSuccessNotification("PR marked as ready for review", 2*time.Second)
			return m, tea.Batch(cmd, m.loadWorktrees())
		}

		// Find the PR that was just marked ready
		for _, pr := range prs {
			if pr.URL == msg.prURL {
				// PR found - now we need to merge it
				// For now, show a notification and reload
				cmd = m.showSuccessNotification("PR marked as ready. Please press M again to merge.", 3*time.Second)
				return m, tea.Batch(cmd, m.loadWorktrees())
			}
		}

		cmd = m.showSuccessNotification("PR marked as ready for review", 2*time.Second)
		return m, tea.Batch(cmd, m.loadWorktrees())

	case prMergedMsg:
		// PR has been merged
		if msg.err != nil {
			cmd = m.showErrorNotification("Failed to merge PR: "+msg.err.Error(), 4*time.Second)
			return m, cmd
		}

		// Mark PR as merged in config
		if m.configManager != nil && msg.branch != "" {
			_ = m.configManager.UpdatePRStatus(m.repoPath, msg.branch, msg.prURL, "merged")
		}

		// Show success and reload worktrees
		cmd = m.showSuccessNotification("PR merged successfully!", 3*time.Second)
		return m, tea.Batch(cmd, m.loadWorktrees())
	}

	return m, cmd
}

func (m Model) handleMainInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg.String() {
	case "q", "ctrl+c":
		// Clear switch info to prevent shell wrapper from switching directories
		m.switchInfo = SwitchInfo{}
		return m, tea.Quit

	case "up":
		if m.selectedIndex > 0 {
			m.selectedIndex--
			// Save the last selected branch
			if wt := m.selectedWorktree(); wt != nil && m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
		}

	case "down":
		if m.selectedIndex < len(m.worktrees)-1 {
			m.selectedIndex++
			// Save the last selected branch
			if wt := m.selectedWorktree(); wt != nil && m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
		}

	case "r":
		// Refresh: pull latest commits, refresh PR statuses, and load PR details for all worktrees
		cmd = m.showInfoNotification("Pulling latest commits and refreshing...")
		return m, tea.Batch(cmd, m.refreshWithPull(), m.refreshPRStatuses(), m.loadPRDetailsForAllWorktrees(), m.checkSessionActivity())

	case "R":
		// Run the 'run' script on selected worktree (Shift+R)
		if m.scriptConfig == nil || m.scriptConfig.GetScript("run") == "" {
			return m, m.showWarningNotification("No 'run' script configured in jean.json")
		}

		wt := m.selectedWorktree()
		if wt == nil {
			return m, m.showErrorNotification("No worktree selected", 2*time.Second)
		}

		// Check if 'run' script is already running for this worktree
		for idx, script := range m.runningScripts {
			if script.name == "run" && script.worktreePath == wt.Path && !script.finished {
				// Script is already running for this worktree, open its output modal
				m.modal = scriptOutputModal
				m.viewingScriptIdx = idx
				m.viewingScriptName = "run"
				return m, nil
			}
		}

		scriptCmd := m.scriptConfig.GetScript("run")

		// Create new script execution
		exec := ScriptExecution{
			name:         "run",
			command:      scriptCmd,
			output:       "",
			finished:     false,
			startTime:    time.Now(),
			worktreePath: wt.Path,
		}
		m.runningScripts = append(m.runningScripts, exec)

		// Switch to script output modal to show progress
		m.modal = scriptOutputModal
		m.viewingScriptIdx = len(m.runningScripts) - 1
		m.viewingScriptName = "run"

		// Run the script asynchronously
		scriptIdx := len(m.runningScripts) - 1
		return m, m.runScript("run", scriptCmd, wt.Path, scriptIdx)

	case "n":
		// Open create with custom name modal
		randomName, err := m.gitManager.GenerateRandomName()
		if err != nil {
			cmd = m.showWarningNotification("Failed to generate random name")
			return m, cmd
		}

		m.modal = createWithNameModal
		m.sessionNameInput.SetValue(randomName)
		m.sessionNameInput.Blur()
		m.modalFocused = 1  // Set create button as default focus
		return m, nil

	case "b":
		// Open change base branch modal (b for base branch)
		m.modal = changeBaseBranchModal
		m.modalFocused = 0
		m.branchIndex = 0
		m.searchInput.SetValue("")
		m.searchInput.Focus()
		m.filteredBranches = nil
		// Try to find current base branch in the list
		return m, m.loadBranches

	case "a":
		// Open create from existing branch modal
		m.modal = branchSelectModal
		m.modalFocused = 0
		m.createNewBranch = false
		m.branchIndex = 0
		m.searchInput.SetValue("")
		m.searchInput.Focus()
		m.filteredBranches = nil
		return m, m.loadBranches

	case "d":
		// Open delete modal
		if wt := m.selectedWorktree(); wt != nil && !wt.IsCurrent {
			// Check for uncommitted changes
			hasUncommitted, err := m.gitManager.HasUncommittedChanges(wt.Path)
			if err != nil {
				cmd = m.showWarningNotification("Failed to check for uncommitted changes")
				return m, cmd
			}
			m.deleteHasUncommitted = hasUncommitted
			m.deleteConfirmForce = false
			m.modal = deleteModal
			m.modalFocused = 0
			return m, nil
		} else if wt != nil && wt.IsCurrent {
			return m, m.showWarningNotification("Cannot delete current worktree")
		}

	case "enter":
		// Switch to selected worktree with Claude
		if wt := m.selectedWorktree(); wt != nil {
			// Save the last selected branch before switching
			if m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
			// Check if this Claude session has been initialized before
			isInitialized := false
			if m.configManager != nil {
				isInitialized = m.configManager.IsClaudeInitialized(m.repoPath, wt.Branch)
				// Mark this branch as initialized for next time
				// (so next run will use --continue instead of plain claude)
				if m.autoClaude && !isInitialized {
					_ = m.configManager.SetClaudeInitialized(m.repoPath, wt.Branch)
				}
			}
			// Store pending switch info and ensure worktree exists
			// SessionName includes repo basename for uniqueness across repositories (e.g., jean-reponame-branch)
			m.pendingSwitchInfo = &SwitchInfo{
				Path:                 wt.Path,
				Branch:               wt.Branch,
				SessionName:          wt.ClaudeSessionName, // Pre-sanitized session name with repo basename
				AutoClaude:           m.autoClaude,
				TargetWindow:         "claude", // Attach to Claude window
				IsClaudeInitialized:  isInitialized,
			}
			m.ensuringWorktree = true
			cmd = m.showInfoNotification("Preparing workspace...")
			return m, tea.Batch(cmd, m.ensureWorktreeExists(wt.Path, wt.Branch))
		}

	case "B":
		// Rename current branch (Shift+B)
		if wt := m.selectedWorktree(); wt != nil {
			// Check if this is a workspace worktree (in .workspaces directory)
			if !strings.Contains(wt.Path, ".workspaces") {
				return m, m.showWarningNotification("Cannot rename main branch. Only workspace branches can be renamed.")
			}

			// Check if this branch has PRs
			if m.configManager != nil && m.configManager.HasPRs(m.repoPath, wt.Branch) {
				return m, m.showErrorNotification("Cannot rename branch with existing PRs. Delete PRs first or close them manually.", 5*time.Second)
			}

			// Check if any scripts are running in this worktree
			for _, script := range m.runningScripts {
				if script.worktreePath == wt.Path && !script.finished {
					return m, m.showWarningNotification("Cannot rename while scripts are running. Stop scripts first (press ';' to view)")
				}
			}

			m.modal = renameModal
			m.modalFocused = 0
			m.nameInput.SetValue(wt.Branch)
			m.nameInput.Focus()
			m.nameInput.CursorEnd()
			return m, nil
		}

	case "g":
		// Open git repository in browser
		if wt := m.selectedWorktree(); wt != nil {
			return m, tea.Batch(
				m.showInfoNotification("Opening in browser..."),
				m.openGitRepo(),
			)
		}

	case "K":
		// Checkout/switch branch in main repository (Shift+K for checkout)
		m.modal = checkoutBranchModal
		m.modalFocused = 0
		m.branchIndex = 0
		m.searchInput.SetValue("")
		m.searchInput.Focus()
		m.filteredBranches = nil
		return m, m.loadBranches

	case "t":
		// Open terminal in the terminal window of the session
		m.debugLog("DEBUG: 't' keybinding pressed, TargetWindow=terminal")
		if wt := m.selectedWorktree(); wt != nil {
			// Save the last selected branch before switching
			if m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
			// Store pending switch info and ensure worktree exists
			m.pendingSwitchInfo = &SwitchInfo{
				Path:         wt.Path,
				Branch:       wt.Branch,
				SessionName:  wt.ClaudeSessionName,     // Pre-sanitized session name with repo basename
				AutoClaude:   false,                    // Never auto-start Claude for terminal window
				TargetWindow: "terminal",               // Attach to terminal window
			}
			m.ensuringWorktree = true
			m.debugLog("DEBUG: ensuring worktree exists before opening terminal")
			cmd = m.showInfoNotification("Preparing workspace...")
			return m, tea.Batch(cmd, m.ensureWorktreeExists(wt.Path, wt.Branch))
		}
		m.debugLog("DEBUG: 't' pressed but no worktree selected")

	case "o":
		// Open worktree in default IDE
		if wt := m.selectedWorktree(); wt != nil {
			cmd = m.showInfoNotification("Opening in editor...")
			return m, tea.Batch(cmd, m.openInEditor(wt.Path))
		}

	case "e":
		// Open editor selection modal
		m.modal = editorSelectModal
		m.modalFocused = 0
		m.editorIndex = 0

		// Find current editor in the list
		if m.configManager != nil {
			currentEditor := m.configManager.GetEditor(m.repoPath)
			for i, editor := range m.editors {
				if editor == currentEditor {
					m.editorIndex = i
					break
				}
			}
		}
		return m, nil

	case "s":
		// Open settings modal
		m.modal = settingsModal
		m.modalFocused = 0
		m.settingsIndex = 0
		return m, nil

	case "S":
		// Open session list modal (Shift+S)
		m.modal = sessionListModal
		m.modalFocused = 0
		m.sessionIndex = 0
		return m, m.loadSessions()

	case ";":
		// Open scripts modal
		if m.scriptConfig != nil && (m.scriptConfig.HasScripts() || len(m.runningScripts) > 0) {
			m.modal = scriptsModal
			m.selectedScriptIdx = 0
			// Start with running scripts if any, otherwise available scripts
			m.isViewingRunning = len(m.runningScripts) > 0
		} else {
			return m, m.showWarningNotification("No scripts configured in jean.json")
		}
		return m, nil

	case "u":
		// Update from base branch (pull/merge base branch changes)
		if wt := m.selectedWorktree(); wt != nil {
			// Check if base branch is set
			if m.baseBranch == "" {
				return m, m.showWarningNotification("Base branch not set. Press 'b' to set base branch")
			}

			// Don't allow pull on main worktree
			if !strings.Contains(wt.Path, ".workspaces") {
				return m, m.showWarningNotification("Cannot pull on main worktree. Use 'git pull' manually.")
			}

			// Fetch and check for updates (don't rely on cached status)
			cmd = m.showInfoNotification("Checking for updates...")
			return m, tea.Batch(cmd, m.checkAndPullFromBase(wt.Path, m.baseBranch))
		}

	case "p":
		// Push branch to remote (with AI branch naming) - lowercase p
		if wt := m.selectedWorktree(); wt != nil {
			// First check if there are uncommitted changes
			hasUncommitted, err := m.gitManager.HasUncommittedChanges(wt.Path)
			if err != nil {
				return m, m.showErrorNotification("Failed to check for uncommitted changes: "+err.Error(), 3*time.Second)
			}

			// Check AI configuration
			hasAPIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
			aiEnabled := m.configManager != nil && m.configManager.GetAIBranchNameEnabled()
			aiContentEnabled := m.configManager != nil && m.configManager.GetAICommitEnabled()
			hasAI := hasAPIKey && (aiEnabled || aiContentEnabled)

			// If there are uncommitted changes, decide how to handle them
			if hasUncommitted {
				if hasAI && aiContentEnabled {
					// AI is enabled for commit messages - generate commit message with AI first
					cmd = m.showInfoNotification("🤖 Generating commit message...")
					m.commitBeforePR = true // Reuse this flag to track commit-before-push
					m.prCreationPending = "" // Empty means push-only (no PR)
					return m, tea.Batch(cmd, m.generateCommitMessageWithAI(wt.Path))
				} else if hasAI {
					// AI is enabled for branch but not commit - auto-commit with simple message and proceed
					cmd = m.showInfoNotification("Committing changes...")
					m.commitBeforePR = true
					m.prCreationPending = "" // Empty means push-only
					return m, tea.Batch(cmd, m.autoCommitBeforePR(wt.Path, wt.Branch))
				} else {
					// No AI - show commit modal for user to write proper commit message
					m.modal = commitModal
					m.modalFocused = 0
					m.commitSubjectInput.SetValue("")
					m.commitSubjectInput.Focus()
					m.commitBodyInput.SetValue("")
					m.commitBeforePR = true
					m.prCreationPending = "" // Empty means push-only
					return m, nil
				}
			}

			// No uncommitted changes - proceed to push
			// Check if we should do AI renaming first
			isRandomName := m.gitManager.IsRandomBranchName(wt.Branch)
			shouldAIRename := hasAPIKey && aiEnabled && isRandomName

			if shouldAIRename {
				// Start AI rename flow before push
				cmd = m.showInfoNotification("🤖 Generating semantic branch name...")
				return m, tea.Batch(cmd, m.generateBranchNameForPush(wt.Path, wt.Branch, m.baseBranch))
			} else {
				// Normal push (no AI)
				cmd = m.showInfoNotification("Pushing to remote...")
				return m, tea.Batch(cmd, m.pushBranch(wt.Path, wt.Branch))
			}
		}

	case "P":
		// Create new PR on GitHub (Shift+P)
		if wt := m.selectedWorktree(); wt != nil {
			// Check if a PR already exists for this branch
			if m.configManager != nil {
				existingPR := m.configManager.GetLatestPR(m.repoPath, wt.Branch)
				if existingPR != nil && existingPR.Status == "open" {
					m.debugLog(fmt.Sprintf("P keybinding: found existing PR #%d for branch %s, opening in browser", existingPR.PRNumber, wt.Branch))
					// Open the existing PR in the browser
					cmd := exec.Command("gh", "pr", "view", existingPR.URL, "--web")
					err := cmd.Start()
					if err != nil {
						return m, m.showErrorNotification("Failed to open PR in browser: "+err.Error(), 3*time.Second)
					}
					notifyMsg := fmt.Sprintf("PR #%d already exists for this branch. Opening in browser...", existingPR.PRNumber)
					return m, m.showInfoNotification(notifyMsg)
				}
			}

			// No existing PR - create new one
			// First fetch from remote to get latest changes
			cmd = m.showInfoNotification("Fetching latest changes...")
			m.prFetchingForCreation = true // Flag to indicate fetch is for PR creation
			return m, tea.Batch(cmd, m.fetchRemoteForPR(wt.Path))
		}

	case "N":
		// Create worktree from existing PR on GitHub (Shift+N)
		m.debugLog("N keybinding pressed - opening PR list modal to create worktree from PR")
		m.modal = prListModal
		m.prListIndex = 0
		m.prListCreationMode = true // Set creation mode flag
		m.prSearchInput.SetValue("")
		m.prSearchInput.Focus()
		m.filteredPRs = nil
		m.prLoadingError = ""
		m.debugLog("PR list modal state: prListCreationMode=true, repoPath=" + m.repoPath)
		return m, m.loadPRs()

	case "c":
		// Commit changes
		if wt := m.selectedWorktree(); wt != nil {
			// Check if worktree has uncommitted changes
			hasUncommitted, err := m.gitManager.HasUncommittedChanges(wt.Path)
			if err != nil {
				return m, m.showErrorNotification("Failed to check for uncommitted changes: " + err.Error(), 3*time.Second)
			}
			if !hasUncommitted {
				cmd = m.showInfoNotification("Nothing to commit - no uncommitted changes in " + wt.Branch)
				return m, cmd
			}

			// Check if AI commit generation is enabled and API key is set
			aiEnabled := m.configManager.GetAICommitEnabled()
			apiKey := m.configManager.GetOpenRouterAPIKey()

			if aiEnabled && apiKey != "" {
				// Auto-generate and auto-commit with AI (no modal shown)
				m.generatingCommit = true
				m.spinnerFrame = 0
				m.autoCommitWithAI = true    // Flag for standalone auto-commit
				notifyCmd := m.showInfoNotification("🤖 Generating commit message...")
				return m, tea.Batch(
					notifyCmd,
					m.animateSpinner(),
					m.generateCommitMessageWithAI(wt.Path),
				)
			} else {
				// Manual commit mode - open modal for user to type message
				m.modal = commitModal
				m.modalFocused = 0
				m.commitSubjectInput.SetValue("")
				m.commitSubjectInput.Focus()
				m.commitBodyInput.SetValue("")
				m.commitModalStatus = "" // Clear any previous status
				return m, nil
			}
		}

	case "v":
		// Open PR in browser - if multiple PRs exist, show selection modal
		if wt := m.selectedWorktree(); wt != nil {
			if prs, ok := wt.PRs.([]config.PRInfo); ok && len(prs) > 0 {
				if len(prs) == 1 {
					// Only one PR - open it directly
					m.debugLog(fmt.Sprintf("v keybinding: opening single PR %s", prs[0].URL))
					cmd := exec.Command("gh", "pr", "view", prs[0].URL, "--web")
					err := cmd.Start()
					if err != nil {
						return m, m.showErrorNotification("Failed to open PR in browser: "+err.Error(), 3*time.Second)
					}
					return m, m.showSuccessNotification("Opening PR in browser...", 2*time.Second)
				} else {
					// Multiple PRs - show selection modal for viewing
					m.debugLog(fmt.Sprintf("v keybinding: opening PR selection modal with %d PRs", len(prs)))
					m.modal = prListModal
					m.prListCreationMode = false  // Ensure NOT creation mode
					m.prListMergeMode = false     // Ensure NOT merge mode
					m.prListViewMode = true       // SET view mode
					m.prListIndex = len(prs) - 1  // Default to most recent
					m.prSearchInput.SetValue("")
					m.prSearchInput.Focus()
					// Convert config.PRInfo to github.PRInfo for display
					m.prs = make([]github.PRInfo, len(prs))
					for i, pr := range prs {
						m.debugLog(fmt.Sprintf("v keybinding: PR[%d] #%d %s - %s", i, pr.PRNumber, pr.Title, pr.URL))
						// Convert config.PRInfo to github.PRInfo for modal display
						m.prs[i] = github.PRInfo{
							Number:      pr.PRNumber,
							Title:       pr.Title, // Now we have the title from config
							URL:         pr.URL,
							HeadRefName: wt.Branch,
							Status:      pr.Status,
						}
						// Set the author
						m.prs[i].Author.Login = pr.Author
					}
					m.filteredPRs = m.prs // Populate filtered PRs with worktree PRs
					m.prLoadingError = ""
					return m, nil
				}
			} else {
				return m, m.showInfoNotification("No PRs found for this worktree")
			}
		}

	case "M":
		// Merge PR (Shift+M)
		if wt := m.selectedWorktree(); wt != nil {
			if prs, ok := wt.PRs.([]config.PRInfo); ok && len(prs) > 0 {
				if len(prs) == 1 {
					// Only one PR - proceed to merge strategy selection
					m.selectedPRForMerge = prs[0].URL
					m.mergeStrategyCursor = 0 // Default to squash
					m.modal = mergeStrategyModal
					return m, nil
				} else {
					// Multiple PRs - show selection modal in merge mode
					m.modal = prListModal
					m.prListMergeMode = true
					m.prListIndex = len(prs) - 1 // Default to most recent
					return m, nil
				}
			} else {
				return m, m.showErrorNotification("No PRs found for this worktree", 3*time.Second)
			}
		}

	case "h":
		// Open help modal
		m.modal = helperModal
		return m, nil
	}

	return m, nil
}

func (m Model) handleModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd

	switch m.modal {
	case createModal:
		return m.handleCreateModalInput(msg)

	case createWithNameModal:
		return m.handleCreateWithNameModalInput(msg)

	case deleteModal:
		return m.handleDeleteModalInput(msg)

	case branchSelectModal:
		return m.handleBranchSelectModalInput(msg)

	case checkoutBranchModal:
		return m.handleCheckoutBranchModalInput(msg)

	case sessionListModal:
		return m.handleSessionListModalInput(msg)

	case renameModal:
		return m.handleRenameModalInput(msg)

	case changeBaseBranchModal:
		return m.handleChangeBaseBranchModalInput(msg)

	case editorSelectModal:
		return m.handleEditorSelectModalInput(msg)

	case themeSelectModal:
		return m.handleThemeSelectModalInput(msg)

	case settingsModal:
		return m.handleSettingsModalInput(msg)

	case aiSettingsModal:
		return m.handleAISettingsModalInput(msg)

	case tmuxConfigModal:
		return m.handleTmuxConfigModalInput(msg)

	case commitModal:
		return m.handleCommitModalInput(msg)

	case prContentModal:
		return m.handlePRContentModalInput(msg)

	case prListModal:
		return m.handlePRListModalInput(msg)

	case prTypeModal:
		return m.handlePRTypeModalInput(msg)

	case mergeStrategyModal:
		return m.handleMergeStrategyModalInput(msg)

	case scriptsModal:
		return m.handleScriptsModalInput(msg)

	case scriptOutputModal:
		return m.handleScriptOutputModalInput(msg)

	case aiPromptsModal:
		return m.handleAIPromptsModalInput(msg)

	case onboardingModal:
		return m.handleOnboardingModalInput(msg)

	case helperModal:
		return m.handleHelperModalInput(msg)
	}

	return m, cmd
}

// handleSearchBasedModalInput is a shared handler for modals with search/filter functionality
// Used by: branchSelectModal, checkoutBranchModal, changeBaseBranchModal
func (m Model) handleSearchBasedModalInput(msg tea.KeyMsg, config searchModalConfig) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd

	switch msg.String() {
	case "esc":
		m.searchInput.Blur()
		// Use custom cancel handler if provided, otherwise default to main view
		if config.onCancel != nil {
			return config.onCancel(m)
		}
		m.modal = noModal
		return m, nil

	case "up":
		if m.modalFocused == 0 {
			// In search input, move focus to list
			m.modalFocused = 1
			m.searchInput.Blur()
		} else if m.modalFocused == 1 && m.branchIndex > 0 {
			// In list, move selection up
			m.branchIndex--
		}
		return m, nil

	case "down":
		if m.modalFocused == 0 {
			// In search input, move focus to list
			m.modalFocused = 1
			m.searchInput.Blur()
		} else if m.modalFocused == 1 {
			// In list, move selection down
			branches := m.filteredBranches
			if len(branches) == 0 {
				branches = m.branches
			}
			if m.branchIndex < len(branches)-1 {
				m.branchIndex++
			}
		}
		return m, nil

	case "tab":
		// Cycle: search -> list -> action button -> cancel button -> search
		m.modalFocused = (m.modalFocused + 1) % 4
		if m.modalFocused == 0 {
			m.searchInput.Focus()
		} else {
			m.searchInput.Blur()
		}
		return m, nil

	case "enter":
		if m.modalFocused == 2 {
			// Action button: Execute the configured action
			branch := m.selectedBranch()
			if branch == "" {
				return m, nil
			}
			m.modal = noModal
			m.searchInput.Blur()
			return config.onConfirm(m, branch)
		} else if m.modalFocused == 3 {
			// Cancel button
			m.modal = noModal
			m.searchInput.Blur()
			return m, nil
		} else if m.modalFocused == 0 || m.modalFocused == 1 {
			// In search input or list: move focus to action button
			m.modalFocused = 2
			m.searchInput.Blur()
			return m, nil
		}
	}

	// Handle search input typing
	// Pass all non-navigation keys to search input when in search or list mode
	if m.modalFocused == 0 || m.modalFocused == 1 {
		// Check if this is a navigation key that's already been handled
		key := msg.String()
		isNavigationKey := key == "up" || key == "down" ||
			key == "tab" || key == "enter" || key == "esc"

		if !isNavigationKey {
			// Pass to search input for typing
			m.searchInput.Focus()
			m.searchInput, cmd = m.searchInput.Update(msg)
			// Filter branches based on search
			m.filteredBranches = m.filterBranches(m.searchInput.Value())
			// Reset branch index when filter changes
			m.branchIndex = 0
			m.modalFocused = 0 // Ensure we're tracking search as focused
		}
	}

	return m, cmd
}

// handleListSelectionModalInput is a shared handler for modals with simple list selection
// Used by: sessionListModal, editorSelectModal
func (m Model) handleListSelectionModalInput(msg tea.KeyMsg, config listSelectionConfig) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		// Use custom cancel handler if provided, otherwise default to main view
		if config.onCancel != nil {
			return config.onCancel(m)
		}
		m.modal = noModal
		return m, nil

	case "up":
		if config.getCurrentIndex() > 0 {
			config.decrementIndex(&m)
		}
		return m, nil

	case "down":
		if config.getCurrentIndex() < config.getItemCount(m)-1 {
			config.incrementIndex(&m)
		}
		return m, nil

	case "enter":
		return config.onConfirm(m)

	default:
		// Allow custom key handling (e.g., "d" for delete in session list)
		if config.onCustomKey != nil {
			return config.onCustomKey(m, msg.String())
		}
	}

	return m, nil
}

// searchModalConfig contains configuration for search-based modals
type searchModalConfig struct {
	onConfirm func(m Model, selectedBranch string) (tea.Model, tea.Cmd)
	onCancel  func(m Model) (tea.Model, tea.Cmd) // Optional: specify where to return on Esc
}

// listSelectionConfig contains configuration for list selection modals
type listSelectionConfig struct {
	getCurrentIndex func() int
	getItemCount    func(m Model) int
	incrementIndex  func(m *Model)
	decrementIndex  func(m *Model)
	onConfirm       func(m Model) (tea.Model, tea.Cmd)
	onCancel        func(m Model) (tea.Model, tea.Cmd) // Optional: specify where to return on Esc
	onCustomKey     func(m Model, key string) (tea.Model, tea.Cmd) // Optional
}

func (m Model) handleCreateModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.modal = noModal
		m.nameInput.Blur()
		return m, nil

	case "tab", "shift+tab":
		// Cycle through: nameInput -> create button -> cancel button (if new branch)
		// or just: create button -> cancel button (if existing branch)
		if m.createNewBranch {
			m.modalFocused = (m.modalFocused + 1) % 3
			if m.modalFocused == 0 {
				m.nameInput.Focus()
			} else {
				m.nameInput.Blur()
			}
		} else {
			// For existing branch, just toggle between buttons
			if m.modalFocused == 0 {
				m.modalFocused = 1
			} else if m.modalFocused == 1 {
				m.modalFocused = 2
			} else {
				m.modalFocused = 1
			}
		}
		return m, nil

	case "enter":
		if m.modalFocused <= 1 {
			// Create button or enter in input
			name := m.nameInput.Value()

			if name == "" {
				m.status = "Branch name is required"
				return m, nil
			}

			// Always generate random path
			path, err := m.gitManager.GetDefaultPath(name)
			if err != nil {
				m.status = "Failed to generate workspace path"
				return m, nil
			}

			return m, m.createWorktree(path, name, m.createNewBranch)
		} else if m.modalFocused == 2 {
			// Cancel button
			m.modal = noModal
			m.nameInput.Blur()
			return m, nil
		}
	}

	// Handle text input for branch name
	var cmd tea.Cmd
	if m.modalFocused == 0 && m.createNewBranch {
		m.nameInput, cmd = m.nameInput.Update(msg)
	}

	return m, cmd
}

func (m Model) handleCreateWithNameModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.modal = noModal
		m.sessionNameInput.Blur()
		return m, nil

	case "tab", "shift+tab":
		// Cycle through: sessionNameInput -> create button -> cancel button
		m.modalFocused = (m.modalFocused + 1) % 3
		if m.modalFocused == 0 {
			m.sessionNameInput.Focus()
		} else {
			m.sessionNameInput.Blur()
		}
		return m, nil

	case "enter":
		if m.modalFocused == 0 {
			// In input, move to create button
			m.modalFocused = 1
			m.sessionNameInput.Blur()
			return m, nil
		} else if m.modalFocused == 1 {
			// Create button
			sessionName := m.sessionNameInput.Value()
			if sessionName == "" {
				cmd := m.showWarningNotification("Session name cannot be empty")
				return m, cmd
			}

			// Sanitize the session name to ensure it's a valid branch name
			sanitizedName := m.sessionManager.SanitizeBranchName(sessionName)
			if sanitizedName == "" {
				cmd := m.showWarningNotification("Session name contains no valid characters")
				return m, cmd
			}

			// Generate path from sanitized session name
			path, err := m.gitManager.GetDefaultPath(sanitizedName)
			if err != nil {
				cmd := m.showWarningNotification("Failed to generate workspace path")
				return m, cmd
			}

			m.modal = noModal
			m.sessionNameInput.Blur()
			notificationMsg := fmt.Sprintf("Creating worktree: %s\n  Path: %s\n  Claude will automatically continue previous conversations", sanitizedName, path)
			cmd := m.showInfoNotification(notificationMsg)
			return m, tea.Batch(cmd, m.createWorktreeWithSession(path, sanitizedName, true))
		} else {
			// Cancel button (modalFocused == 2)
			m.modal = noModal
			m.sessionNameInput.Blur()
			return m, nil
		}
	}

	// Handle text input
	var cmd tea.Cmd
	if m.modalFocused == 0 {
		m.sessionNameInput, cmd = m.sessionNameInput.Update(msg)
	}

	return m, cmd
}

func (m Model) handleDeleteModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "n":
		m.modal = noModal
		return m, nil

	case "tab", "left", "right":
		// If uncommitted changes, we have 3 buttons (Yes/No/Force), otherwise 2 (Yes/No)
		if m.deleteHasUncommitted {
			m.modalFocused = (m.modalFocused + 1) % 3
		} else {
			m.modalFocused = (m.modalFocused + 1) % 2
		}

	case "enter", "y":
		// If there are uncommitted changes and user hasn't confirmed force
		if m.deleteHasUncommitted && !m.deleteConfirmForce {
			// modalFocused: 0 = Yes (blocked), 1 = No, 2 = Force Delete
			if m.modalFocused == 2 || msg.String() == "f" {
				// User clicked "Force Delete" - set confirmation flag
				m.deleteConfirmForce = true
				return m, m.showWarningNotification("Press 'y' or Enter to confirm force delete")
			} else if m.modalFocused == 1 || msg.String() == "n" {
				// User clicked "No" - cancel
				m.modal = noModal
				return m, nil
			} else if m.modalFocused == 0 {
				// User tried to click "Yes" but it's blocked
				return m, m.showWarningNotification("Cannot delete: uncommitted changes. Use 'Force Delete' to proceed.")
			}
		} else if m.deleteHasUncommitted && m.deleteConfirmForce {
			// User already confirmed, now execute force delete
			if m.modalFocused == 0 || msg.String() == "y" {
				if wt := m.selectedWorktree(); wt != nil {
					m.modal = noModal
					return m, m.deleteWorktree(wt.Path, wt.Branch, true) // force = true
				}
			}
			m.modal = noModal
			return m, nil
		} else {
			// No uncommitted changes, normal delete
			if m.modalFocused == 0 || msg.String() == "y" {
				if wt := m.selectedWorktree(); wt != nil {
					m.modal = noModal
					return m, m.deleteWorktree(wt.Path, wt.Branch, false)
				}
			}
			m.modal = noModal
			return m, nil
		}

	case "f":
		// Shortcut for "Force Delete"
		if m.deleteHasUncommitted && !m.deleteConfirmForce {
			m.deleteConfirmForce = true
			return m, m.showWarningNotification("Press 'y' or Enter to confirm force delete")
		}
	}

	return m, nil
}

func (m Model) handleBranchSelectModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			// Generate random path
			path, err := m.gitManager.GetDefaultPath(branch)
			if err != nil {
				cmd := m.showWarningNotification("Failed to generate workspace path")
				return m, cmd
			}
			return m, m.createWorktree(path, branch, false)
		},
	}
	return m.handleSearchBasedModalInput(msg, config)
}

func (m Model) handleCheckoutBranchModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			cmd := m.showInfoNotification("Checking out branch: " + branch)
			return m, tea.Batch(cmd, m.checkoutBranch(branch))
		},
	}
	return m.handleSearchBasedModalInput(msg, config)
}

func (m Model) handleSessionListModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.sessionIndex },
		getItemCount:    func(m Model) int { return len(m.sessions) },
		incrementIndex:  func(m *Model) { m.sessionIndex++ },
		decrementIndex:  func(m *Model) { m.sessionIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			if m.sessionIndex >= 0 && m.sessionIndex < len(m.sessions) {
				sess := m.sessions[m.sessionIndex]
				// Attach via tmux
				if err := m.sessionManager.Attach(sess.Name); err != nil {
					m.showErrorNotification("Failed to attach to session", 3*time.Second)
					return m, nil
				}
				return m, tea.Quit
			}
			return m, nil
		},
		onCustomKey: func(m Model, key string) (tea.Model, tea.Cmd) {
			if key == "d" && m.sessionIndex >= 0 && m.sessionIndex < len(m.sessions) {
				// Kill selected session
				sess := m.sessions[m.sessionIndex]
				if err := m.sessionManager.Kill(sess.Name); err != nil {
					m.showErrorNotification("Failed to kill session", 3*time.Second)
				} else {
					m.showSuccessNotification("Session killed", 3*time.Second)
					// Reload sessions
					return m, m.loadSessions()
				}
			}
			return m, nil
		},
	}
	return m.handleListSelectionModalInput(msg, config)
}

func (m Model) handleRenameModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.modal = noModal
		m.nameInput.Blur()
		// Clear rename generation state when closing modal
		m.generatingRename = false
		m.renameSpinnerFrame = 0
		m.renameModalStatus = ""
		return m, nil

	case "g":
		// AI-generate branch name (only when focused on buttons, not input field)
		if m.modalFocused > 0 && m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != "" {
			if wt := m.selectedWorktree(); wt != nil {
				m.generatingRename = true
				m.renameSpinnerFrame = 0
				m.renameModalStatus = ""
				return m, tea.Batch(
					m.animateRenameSpinner(),
					m.generateRenameWithAI(wt.Path, m.baseBranch),
				)
			}
		}
		// If in input field (modalFocused == 0), fall through to handle text input

	case "tab", "shift+tab":
		// Toggle between input and buttons
		m.modalFocused = (m.modalFocused + 1) % 3
		if m.modalFocused == 0 {
			m.nameInput.Focus()
		} else {
			m.nameInput.Blur()
		}
		return m, nil

	case "enter":
		if m.modalFocused <= 1 {
			// Rename button or enter in input
			newName := m.nameInput.Value()
			if newName == "" {
				cmd := m.showWarningNotification("Branch name cannot be empty")
				return m, cmd
			}

			// Sanitize branch name
			newName = git.SanitizeBranchName(newName)
			if newName == "" {
				cmd := m.showWarningNotification("Branch name cannot be empty after sanitization")
				return m, cmd
			}

			if wt := m.selectedWorktree(); wt != nil {
				if newName == wt.Branch {
					cmd := m.showInfoNotification("Branch name unchanged")
					m.modal = noModal
					m.nameInput.Blur()
					return m, cmd
				}

				cmd := m.showInfoNotification(fmt.Sprintf("Renaming branch to '%s'...", newName))
				m.modal = noModal
				m.nameInput.Blur()
				return m, tea.Batch(cmd, m.renameBranch(wt.Branch, newName, wt.Path))
			}
		} else if m.modalFocused == 2 {
			// Cancel button
			m.modal = noModal
			m.nameInput.Blur()
			return m, nil
		}
	}

	// Handle text input
	var cmd tea.Cmd
	if m.modalFocused == 0 {
		m.nameInput, cmd = m.nameInput.Update(msg)
	}

	return m, cmd
}

func (m Model) handleChangeBaseBranchModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			m.baseBranch = branch
			var cmd tea.Cmd

			// Save to config
			if m.configManager != nil {
				if err := m.configManager.SetBaseBranch(m.repoPath, branch); err != nil {
					cmd = m.showWarningNotification("Base branch set to: " + branch + " (warning: failed to save)")
				} else {
					cmd = m.showSuccessNotification("Base branch set to: " + branch, 3*time.Second)
				}
			} else {
				cmd = m.showInfoNotification("Base branch set to: " + branch)
			}
			m.modal = settingsModal
			m.settingsIndex = 2
			return m, cmd
		},
		onCancel: func(m Model) (tea.Model, tea.Cmd) {
			// Return to settings modal
			m.modal = settingsModal
			m.settingsIndex = 2
			return m, nil
		},
	}
	return m.handleSearchBasedModalInput(msg, config)
}

func (m Model) handleCommitModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.modal = noModal
		m.commitSubjectInput.Blur()
		m.commitBodyInput.Blur()
		return m, nil

	case "tab", "shift+tab":
		// Cycle through: subject input -> body input -> commit button -> cancel button
		m.modalFocused = (m.modalFocused + 1) % 4

		// Update focus state
		if m.modalFocused == 0 {
			m.commitSubjectInput.Focus()
			m.commitBodyInput.Blur()
		} else if m.modalFocused == 1 {
			m.commitSubjectInput.Blur()
			m.commitBodyInput.Focus()
		} else {
			m.commitSubjectInput.Blur()
			m.commitBodyInput.Blur()
		}
		return m, nil

	case "g":
		// Generate AI commit message (only if not focused on input fields and API key is configured)
		if m.modalFocused > 1 && m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != "" {
			if wt := m.selectedWorktree(); wt != nil {
				m.generatingCommit = true
				m.spinnerFrame = 0
				m.commitModalStatus = ""
				return m, tea.Batch(
					m.animateSpinner(),
					m.generateCommitMessageWithAI(wt.Path),
				)
			}
		}
		// If in input field (modalFocused 0 or 1), fall through to handle text input

	case "enter":
		if m.modalFocused == 0 {
			// In subject input, move to body
			m.modalFocused = 1
			m.commitSubjectInput.Blur()
			m.commitBodyInput.Focus()
			return m, nil
		} else if m.modalFocused == 1 {
			// In body input, move to commit button
			m.modalFocused = 2
			m.commitBodyInput.Blur()
			return m, nil
		} else if m.modalFocused == 2 {
			// Commit button
			subject := m.commitSubjectInput.Value()
			if subject == "" {
				// If AI commit is enabled and API key is configured, try auto-generate
				if m.configManager != nil && m.configManager.GetAICommitEnabled() && m.configManager.GetOpenRouterAPIKey() != "" {
					if wt := m.selectedWorktree(); wt != nil {
						m.generatingCommit = true
						m.spinnerFrame = 0
						m.commitModalStatus = ""
						return m, tea.Batch(
							m.animateSpinner(),
							m.generateCommitMessageWithAI(wt.Path),
						)
					}
				} else {
					// No AI generation, show error
					cmd := m.showWarningNotification("Commit subject cannot be empty")
					return m, cmd
				}
			}

			body := m.commitBodyInput.Value()
			if wt := m.selectedWorktree(); wt != nil {
				cmd := m.showInfoNotification("Creating commit...")
				m.modal = noModal
				m.commitSubjectInput.Blur()
				m.commitBodyInput.Blur()
				return m, tea.Batch(cmd, m.createCommit(wt.Path, subject, body))
			}
		} else {
			// Cancel button (modalFocused == 3)
			m.modal = noModal
			m.commitSubjectInput.Blur()
			m.commitBodyInput.Blur()
			return m, nil
		}
	}

	// Handle text input
	var cmd tea.Cmd
	if m.modalFocused == 0 {
		m.commitSubjectInput, cmd = m.commitSubjectInput.Update(msg)
	} else if m.modalFocused == 1 {
		m.commitBodyInput, cmd = m.commitBodyInput.Update(msg)
	}

	return m, cmd
}

func (m Model) handlePRContentModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.modal = noModal
		m.prTitleInput.Blur()
		m.prDescriptionInput.Blur()
		return m, nil

	case "tab", "shift+tab":
		// Cycle through: title input -> description input -> create button -> cancel button
		m.prModalFocused = (m.prModalFocused + 1) % 4

		// Update focus state
		if m.prModalFocused == 0 {
			m.prTitleInput.Focus()
			m.prDescriptionInput.Blur()
		} else if m.prModalFocused == 1 {
			m.prTitleInput.Blur()
			m.prDescriptionInput.Focus()
		} else {
			m.prTitleInput.Blur()
			m.prDescriptionInput.Blur()
		}
		return m, nil

	case "g":
		// Generate AI PR content (only if not focused on input fields and API key is configured)
		if m.prModalFocused > 1 && m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != "" {
			m.generatingPRContent = true
			m.prSpinnerFrame = 0
			return m, tea.Batch(
				m.animateSpinner(),
				m.generatePRContent(m.prModalWorktreePath, m.prModalBranch, m.baseBranch),
			)
		}
		// If in input field (prModalFocused 0 or 1), fall through to handle text input

	case "enter":
		if m.prModalFocused == 0 {
			// In title input, move to description
			m.prModalFocused = 1
			m.prTitleInput.Blur()
			m.prDescriptionInput.Focus()
			return m, nil
		} else if m.prModalFocused == 1 {
			// In description input, move to create button
			m.prModalFocused = 2
			m.prDescriptionInput.Blur()
			return m, nil
		} else if m.prModalFocused == 2 {
			// Create button
			title := m.prTitleInput.Value()
			description := m.prDescriptionInput.Value()

			// Validate title
			if title == "" {
				cmd := m.showWarningNotification("PR title cannot be empty")
				return m, cmd
			}

			// Create the PR
			cmd := m.showInfoNotification("Creating draft PR...")
			m.modal = noModal
			m.prTitleInput.Blur()
			m.prDescriptionInput.Blur()
			return m, tea.Batch(
				cmd,
				m.createPR(m.prModalWorktreePath, m.prModalBranch, title, description),
			)
		} else {
			// Cancel button (prModalFocused == 3)
			m.modal = noModal
			m.prTitleInput.Blur()
			m.prDescriptionInput.Blur()
			return m, nil
		}
	}

	// Handle text input
	var cmd tea.Cmd
	if m.prModalFocused == 0 {
		m.prTitleInput, cmd = m.prTitleInput.Update(msg)
	} else if m.prModalFocused == 1 {
		m.prDescriptionInput, cmd = m.prDescriptionInput.Update(msg)
	}

	return m, cmd
}

func (m Model) handlePRListModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.debugLog("handlePRListModalInput: ESC pressed - closing PR list modal")
		m.modal = noModal
		m.prListMergeMode = false
		m.prListCreationMode = false
		m.prListViewMode = false
		m.prListIndex = 0
		m.prSearchInput.Blur()
		return m, nil

	case "up":
		if m.prListIndex > 0 {
			m.prListIndex--
		}
		m.debugLog(fmt.Sprintf("handlePRListModalInput: UP pressed - prListIndex now %d", m.prListIndex))
		return m, nil

	case "down":
		// Get the filtered PR list based on current search
		filteredList := m.filterPRs(m.prSearchInput.Value())
		if m.prListIndex < len(filteredList)-1 {
			m.prListIndex++
		}
		m.debugLog(fmt.Sprintf("handlePRListModalInput: DOWN pressed - prListIndex now %d (max %d)", m.prListIndex, len(filteredList)-1))
		return m, nil

	case "tab":
		// Cycle focus: search -> list -> OK button -> Cancel button -> search
		m.modalFocused = (m.modalFocused + 1) % 4
		if m.modalFocused == 0 {
			m.prSearchInput.Focus()
		} else {
			m.prSearchInput.Blur()
		}
		m.debugLog(fmt.Sprintf("handlePRListModalInput: TAB pressed - modalFocused now %d", m.modalFocused))
		return m, nil

	case "enter":
		// Get filtered PRs for selection
		filteredList := m.filterPRs(m.prSearchInput.Value())
		m.debugLog(fmt.Sprintf("handlePRListModalInput: ENTER pressed - filtered list has %d PRs, selected index=%d", len(filteredList), m.prListIndex))

		if m.prListIndex >= len(filteredList) {
			m.debugLog("handlePRListModalInput: ENTER - index out of bounds, aborting")
			return m, nil
		}

		if len(filteredList) == 0 {
			m.debugLog("handlePRListModalInput: ENTER - no filtered PRs, aborting")
			return m, nil
		}

		selectedPR := filteredList[m.prListIndex]
		m.debugLog(fmt.Sprintf("handlePRListModalInput: ENTER - selected PR #%d - %s (branch: %s)", selectedPR.Number, selectedPR.Title, selectedPR.HeadRefName))

		// Handle creation mode: create worktree from PR branch
		if m.prListCreationMode {
			m.debugLog(fmt.Sprintf("handlePRListModalInput: CREATION MODE - creating worktree from PR branch: %s", selectedPR.HeadRefName))

			// Store PR info temporarily (will be saved after worktree is created)
			prCopy := selectedPR // Make a copy to avoid pointer issues
			m.pendingPRInfo = &prCopy
			m.debugLog(fmt.Sprintf("handlePRListModalInput: stored pendingPRInfo - PR #%d: %s (URL: %s)", selectedPR.Number, selectedPR.Title, selectedPR.URL))

			m.modal = noModal
			m.prListCreationMode = false
			m.prListIndex = 0
			m.prSearchInput.SetValue("")
			m.prSearchInput.Blur()
			cmd := m.showInfoNotification("Creating worktree from PR...")
			return m, tea.Batch(cmd, m.createWorktreeFromPR(selectedPR.HeadRefName))
		} else if m.prListViewMode {
			// Handle view mode: user pressed 'v' and is selecting a PR to view
			m.debugLog(fmt.Sprintf("handlePRListModalInput: VIEW MODE - opening selected PR in browser: %s", selectedPR.URL))
			m.modal = noModal
			m.prListViewMode = false
			cmd := exec.Command("gh", "pr", "view", selectedPR.URL, "--web")
			err := cmd.Start()
			if err != nil {
				return m, m.showErrorNotification("Failed to open PR in browser: "+err.Error(), 3*time.Second)
			}
			return m, m.showSuccessNotification("Opening PR in browser...", 2*time.Second)
		} else {
			// Handle merge or default mode (for worktree PRs)
			wt := m.selectedWorktree()
			if wt == nil {
				m.modal = noModal
				m.prListMergeMode = false
				return m, nil
			}

			// Get PRs from worktree
			prList, ok := wt.PRs.([]config.PRInfo)
			if !ok || len(prList) == 0 {
				m.modal = noModal
				m.prListMergeMode = false
				return m, nil
			}

			// Find matching PR by branch name
			var selectedConfigPR config.PRInfo
			for _, pr := range prList {
				if pr.Branch == selectedPR.HeadRefName {
					selectedConfigPR = pr
					break
				}
			}

			if selectedConfigPR.URL == "" {
				m.modal = noModal
				return m, m.showErrorNotification("PR not found in worktree", 3*time.Second)
			}

			if m.prListMergeMode {
				// User is merging a PR - proceed to merge strategy selection
				m.selectedPRForMerge = selectedConfigPR.URL
				m.mergeStrategyCursor = 0 // Default to squash
				m.modal = mergeStrategyModal
				m.prListMergeMode = false
				return m, nil
			} else {
				// This should not happen, but handle it gracefully
				m.modal = noModal
				return m, m.showWarningNotification("Unknown PR modal mode")
			}
		}

	default:
		// Pass all other input to the search input when it's focused
		if m.modalFocused == 0 {
			oldValue := m.prSearchInput.Value()
			m.prSearchInput, _ = m.prSearchInput.Update(msg)
			newValue := m.prSearchInput.Value()

			// If search value changed, reset list index
			if oldValue != newValue {
				m.prListIndex = 0
			}

			return m, nil
		}
		return m, nil
	}
}

func (m Model) handleMergeStrategyModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.modal = noModal
		m.selectedPRForMerge = ""
		return m, nil

	case "up":
		if m.mergeStrategyCursor > 0 {
			m.mergeStrategyCursor--
		}
		return m, nil

	case "down":
		if m.mergeStrategyCursor < 2 {
			m.mergeStrategyCursor++
		}
		return m, nil

	case "enter":
		// User confirmed merge strategy selection
		if m.selectedPRForMerge == "" {
			m.modal = noModal
			return m, m.showErrorNotification("No PR selected for merge", 3*time.Second)
		}

		// Get the selected merge method
		mergeStrategies := []string{"squash", "merge", "rebase"}
		mergeMethod := mergeStrategies[m.mergeStrategyCursor]

		// Get the selected worktree to determine if PR is draft
		wt := m.selectedWorktree()
		if wt == nil {
			m.modal = noModal
			return m, m.showErrorNotification("No worktree selected", 3*time.Second)
		}

		// Get the PR info to check its status
		prs, ok := wt.PRs.([]config.PRInfo)
		if !ok || len(prs) == 0 {
			m.modal = noModal
			return m, m.showErrorNotification("No PR found", 3*time.Second)
		}

		// Find the selected PR
		selectedPR := config.PRInfo{}
		for _, pr := range prs {
			if pr.URL == m.selectedPRForMerge {
				selectedPR = pr
				break
			}
		}

		if selectedPR.URL == "" {
			m.modal = noModal
			return m, m.showErrorNotification("PR not found", 3*time.Second)
		}

		// Check PR status - if draft, mark as ready first
		if selectedPR.Status == "draft" {
			m.modal = noModal
			m.selectedPRForMerge = ""
			notifyCmd := m.showInfoNotification("⏳ Marking PR as ready...")
			return m, tea.Batch(
				notifyCmd,
				m.markPRReady(wt.Path, selectedPR.URL),
			)
		}

		// PR is already ready/open - proceed directly to merge
		m.modal = noModal
		m.selectedPRForMerge = ""
		notifyCmd := m.showInfoNotification("⏳ Merging PR with " + mergeMethod + " strategy...")
		return m, tea.Batch(
			notifyCmd,
			m.mergePR(wt.Path, selectedPR.URL, mergeMethod),
		)
	}

	return m, nil
}

func (m Model) handlePRTypeModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.modal = noModal
		return m, nil

	case "up":
		if m.prTypeCursor > 0 {
			m.prTypeCursor--
		}
		return m, nil

	case "down":
		if m.prTypeCursor < 1 {
			m.prTypeCursor++
		}
		return m, nil

	case "enter":
		// User confirmed PR type selection
		// Set isDraft based on selection (0=draft, 1=ready for review)
		m.prIsDraft = (m.prTypeCursor == 0)

		// Close modal and proceed to AI generation or PR content modal
		m.modal = noModal

		// Check if AI is enabled for PR content generation
		aiEnabled := m.configManager != nil &&
			m.configManager.GetOpenRouterAPIKey() != "" &&
			m.aiCommitEnabled

		if aiEnabled {
			// Generate PR content with AI
			return m, m.generatePRContent(m.prModalWorktreePath, m.prModalBranch, m.baseBranch)
		}

		// No AI - open PR content modal for manual input
		m.modal = prContentModal
		m.prModalFocused = 0
		m.prTitleInput.Focus()
		m.prDescriptionInput.Blur()
		return m, nil
	}

	return m, nil
}

func (m Model) handleEditorSelectModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	config := listSelectionConfig{
		getCurrentIndex: func() int { return m.editorIndex },
		getItemCount:    func(m Model) int { return len(m.editors) },
		incrementIndex:  func(m *Model) { m.editorIndex++ },
		decrementIndex:  func(m *Model) { m.editorIndex-- },
		onConfirm: func(m Model) (tea.Model, tea.Cmd) {
			if m.editorIndex >= 0 && m.editorIndex < len(m.editors) {
				selectedEditor := m.editors[m.editorIndex]
				if m.configManager != nil {
					if err := m.configManager.SetEditor(m.repoPath, selectedEditor); err != nil {
						m.showErrorNotification("Failed to save editor preference", 3*time.Second)
					} else {
						m.showSuccessNotification("Editor set to: " + selectedEditor, 3*time.Second)
					}
				}
			}
			m.modal = settingsModal
			m.settingsIndex = 0
			return m, nil
		},
		onCancel: func(m Model) (tea.Model, tea.Cmd) {
			// Return to settings modal
			m.modal = settingsModal
			m.settingsIndex = 0
			return m, nil
		},
	}
	return m.handleListSelectionModalInput(msg, config)
}

func (m Model) handleThemeSelectModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		// Revert to original theme when cancelling
		if m.originalTheme != "" {
			ApplyTheme(m.originalTheme)
		}
		m.modal = settingsModal
		m.settingsIndex = 1
		return m, nil

	case "up":
		if m.themeIndex > 0 {
			m.themeIndex--
			// Apply theme preview immediately
			selectedTheme := m.availableThemes[m.themeIndex]
			themeName := strings.ToLower(selectedTheme.Name)
			if err := ApplyTheme(themeName); err == nil {
				// Theme applied successfully, UI will refresh with new colors
			}
		}
		return m, nil

	case "down":
		if m.themeIndex < len(m.availableThemes)-1 {
			m.themeIndex++
			// Apply theme preview immediately
			selectedTheme := m.availableThemes[m.themeIndex]
			themeName := strings.ToLower(selectedTheme.Name)
			if err := ApplyTheme(themeName); err == nil {
				// Theme applied successfully, UI will refresh with new colors
			}
		}
		return m, nil

	case "enter":
		// Save the selected theme
		if m.themeIndex >= 0 && m.themeIndex < len(m.availableThemes) {
			selectedTheme := m.availableThemes[m.themeIndex]
			themeName := strings.ToLower(selectedTheme.Name)
			cmd := m.changeTheme(themeName)
			m.modal = settingsModal
			m.settingsIndex = 1
			return m, cmd
		}
		m.modal = settingsModal
		m.settingsIndex = 1
		return m, nil
	}

	return m, nil
}

func (m Model) handleSettingsModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.modal = noModal
		return m, nil

	case "up":
		if m.settingsIndex > 0 {
			m.settingsIndex--
		}

	case "down":
		if m.settingsIndex < 5 { // Now 6 settings (editor, theme, base branch, tmux config, AI integration, debug logs)
			m.settingsIndex++
		}

	case "e":
		// Quick key for Editor
		m.settingsIndex = 0
		msg = tea.KeyMsg{Type: tea.KeyEnter}
		return m.handleSettingsModalInput(msg)

	case "h":
		// Quick key for Theme (h for "theme" - using h since t is taken for Tmux)
		m.settingsIndex = 1
		msg = tea.KeyMsg{Type: tea.KeyEnter}
		return m.handleSettingsModalInput(msg)

	case "c":
		// Quick key for Base Branch
		m.settingsIndex = 2
		msg = tea.KeyMsg{Type: tea.KeyEnter}
		return m.handleSettingsModalInput(msg)

	case "t":
		// Quick key for Tmux Config
		m.settingsIndex = 3
		msg = tea.KeyMsg{Type: tea.KeyEnter}
		return m.handleSettingsModalInput(msg)

	case "a":
		// Quick key for AI Integration
		m.settingsIndex = 4
		msg = tea.KeyMsg{Type: tea.KeyEnter}
		return m.handleSettingsModalInput(msg)

	case "d":
		// Quick key for Debug Logs
		m.settingsIndex = 5
		msg = tea.KeyMsg{Type: tea.KeyEnter}
		return m.handleSettingsModalInput(msg)

	case "enter":
		// Open the selected setting's modal
		switch m.settingsIndex {
		case 0:
			// Editor setting - open editor select modal
			m.modal = editorSelectModal
			m.modalFocused = 0
			m.editorIndex = 0

			// Find current editor in the list
			if m.configManager != nil {
				currentEditor := m.configManager.GetEditor(m.repoPath)
				for i, editor := range m.editors {
					if editor == currentEditor {
						m.editorIndex = i
						break
					}
				}
			}
			return m, nil

		case 1:
			// Theme setting - open theme select modal
			m.modal = themeSelectModal
			m.modalFocused = 0
			m.themeIndex = 0

			// Store original theme for preview revert
			if m.configManager != nil {
				m.originalTheme = m.configManager.GetTheme(m.repoPath)
			}

			// Find current theme in the list
			if m.configManager != nil {
				currentTheme := m.configManager.GetTheme(m.repoPath)
				for i, theme := range m.availableThemes {
					if theme.Name == strings.ToTitle(currentTheme) || theme.Name == strings.Title(currentTheme) {
						m.themeIndex = i
						break
					}
				}
			}
			return m, nil

		case 2:
			// Base branch setting - open change base branch modal
			m.modal = changeBaseBranchModal
			m.modalFocused = 0
			m.branchIndex = 0
			m.searchInput.SetValue("")
			m.searchInput.Focus()
			m.filteredBranches = nil
			return m, m.loadBranches

		case 3:
			// Tmux config setting - open tmux config modal
			m.modal = tmuxConfigModal
			m.modalFocused = 0
			return m, nil

		case 4:
			// AI Integration setting - open AI settings modal
			m.modal = aiSettingsModal
			m.modalFocused = 0
			m.aiSettingsIndex = 0
			m.aiAPIKeyInput.Focus()
			m.aiModalStatus = "" // Clear any previous status
			return m, nil

		case 5:
			// Debug Logs setting - toggle debug logging
			if m.configManager != nil {
				enabled := m.configManager.GetDebugLoggingEnabled()
				if err := m.configManager.SetDebugLoggingEnabled(!enabled); err != nil {
					cmd := m.showErrorNotification("Failed to save debug logs setting: "+err.Error(), 3*time.Second)
					return m, cmd
				}
				if !enabled {
					cmd := m.showSuccessNotification("Debug logging enabled", 2*time.Second)
					return m, cmd
				} else {
					cmd := m.showSuccessNotification("Debug logging disabled", 2*time.Second)
					return m, cmd
				}
			}
			return m, nil
		}
	}

	return m, nil
}

func (m Model) handleAISettingsModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd

	switch msg.String() {
	case "esc", "q":
		// Close without saving
		m.modal = settingsModal
		m.settingsIndex = 4 // Go back to AI Integration option in settings
		return m, nil

	case "tab":
		// Tab cycles through: API key input (0) -> Model (1) -> AI Commit toggle (2) -> AI Branch toggle (3) -> Test (4) -> Customize Prompts (5) -> Save (6) -> Cancel (7) -> Clear (8) -> back to API key
		m.aiModalFocusedField = (m.aiModalFocusedField + 1) % 9
		if m.aiModalFocusedField == 0 {
			m.aiAPIKeyInput.Focus()
		} else {
			m.aiAPIKeyInput.Blur()
		}
		return m, nil

	case "shift+tab":
		// Shift+Tab goes backwards
		m.aiModalFocusedField = (m.aiModalFocusedField - 1 + 9) % 9
		if m.aiModalFocusedField == 0 {
			m.aiAPIKeyInput.Focus()
		} else {
			m.aiAPIKeyInput.Blur()
		}
		return m, nil

	case "up":
		if m.aiModalFocusedField == 1 && m.aiModelIndex > 0 {
			// In model selection, move up
			m.aiModelIndex--
		}
		return m, nil

	case "down":
		if m.aiModalFocusedField == 1 && m.aiModelIndex < len(m.aiModels)-1 {
			// In model selection, move down
			m.aiModelIndex++
		}
		return m, nil

	case "space", "enter":
		if m.aiModalFocusedField == 2 {
			// Toggle AI commit enabled
			m.aiCommitEnabled = !m.aiCommitEnabled
			return m, nil
		} else if m.aiModalFocusedField == 3 {
			// Toggle AI branch name enabled
			m.aiBranchNameEnabled = !m.aiBranchNameEnabled
			return m, nil
		} else if m.aiModalFocusedField == 4 {
			// Test button
			apiKey := m.aiAPIKeyInput.Value()
			if apiKey == "" {
				return m, m.showWarningNotification("API key cannot be empty - enter key first")
			}
			model := m.aiModels[m.aiModelIndex]
			cmd := m.showInfoNotification("Testing API key...")
			return m, tea.Batch(cmd, m.testOpenRouterAPIKey(apiKey, model))
		} else if m.aiModalFocusedField == 5 {
			// Customize Prompts button
			m.modal = aiPromptsModal
			m.aiPromptsModalFocus = 0
			m.aiPromptsStatus = ""
			// Load current prompts
			return m, m.loadAIPrompts()
		} else if m.aiModalFocusedField == 6 {
			// Save button
			apiKey := m.aiAPIKeyInput.Value()
			if apiKey == "" {
				return m, m.showWarningNotification("API key cannot be empty")
			}

			// Save all settings to config
			var cmd tea.Cmd
			if m.configManager != nil {
				if err := m.configManager.SetOpenRouterAPIKey(apiKey); err != nil {
					return m, m.showErrorNotification("Failed to save API key: " + err.Error(), 3*time.Second)
				}
				if err := m.configManager.SetOpenRouterModel(m.aiModels[m.aiModelIndex]); err != nil {
					return m, m.showErrorNotification("Failed to save model: " + err.Error(), 3*time.Second)
				}
				if err := m.configManager.SetAICommitEnabled(m.aiCommitEnabled); err != nil {
					return m, m.showErrorNotification("Failed to save AI commit setting: " + err.Error(), 3*time.Second)
				}
				if err := m.configManager.SetAIBranchNameEnabled(m.aiBranchNameEnabled); err != nil {
					return m, m.showErrorNotification("Failed to save AI branch name setting: " + err.Error(), 3*time.Second)
				}
				cmd = m.showSuccessNotification("AI settings saved successfully", 2*time.Second)
			}

			// Return to settings modal
			m.modal = settingsModal
			m.settingsIndex = 4
			m.aiAPIKeyInput.Blur()
			return m, cmd
		} else if m.aiModalFocusedField == 7 {
			// Cancel button
			m.modal = settingsModal
			m.settingsIndex = 4
			m.aiAPIKeyInput.Blur()
			return m, nil
		} else if m.aiModalFocusedField == 8 {
			// Clear button - remove API key
			m.aiAPIKeyInput.SetValue("")
			if m.configManager != nil {
				if err := m.configManager.SetOpenRouterAPIKey(""); err != nil {
					return m, m.showErrorNotification("Failed to clear API key: " + err.Error(), 3*time.Second)
				}
			}
			cmd := m.showSuccessNotification("API key cleared - AI features disabled", 2*time.Second)
			m.modal = settingsModal
			m.settingsIndex = 4
			m.aiAPIKeyInput.Blur()
			return m, cmd
		}

	default:
		// If in API key input field, pass keystroke to text input
		if m.aiModalFocusedField == 0 {
			m.aiAPIKeyInput, cmd = m.aiAPIKeyInput.Update(msg)
			return m, cmd
		}
	}

	return m, cmd
}

// handleAIPromptsModalInput handles input for the AI prompts customization modal
func (m Model) handleAIPromptsModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd

	switch msg.String() {
	case "esc", "q":
		// Close without saving
		m.modal = aiSettingsModal
		m.aiModalFocusedField = 0
		return m, nil

	case "tab":
		// Tab cycles through: commit (0) -> branch (1) -> pr (2) -> save (3) -> reset (4) -> cancel (5) -> back to commit
		m.aiPromptsModalFocus = (m.aiPromptsModalFocus + 1) % 6
		m.updateAIPromptsInputFocus()
		return m, nil

	case "shift+tab":
		// Shift+Tab goes backwards
		m.aiPromptsModalFocus = (m.aiPromptsModalFocus - 1 + 6) % 6
		m.updateAIPromptsInputFocus()
		return m, nil

	case "enter":
		if m.aiPromptsModalFocus == 3 {
			// Save button
			commitPrompt := m.aiPromptCommitInput.Value()
			branchPrompt := m.aiPromptBranchInput.Value()
			prPrompt := m.aiPromptPRInput.Value()

			// Validate that prompts contain {diff} placeholder
			if !strings.Contains(commitPrompt, "{diff}") {
				m.aiPromptsStatus = "Commit prompt must contain {diff} placeholder"
				return m, nil
			}
			if !strings.Contains(branchPrompt, "{diff}") {
				m.aiPromptsStatus = "Branch prompt must contain {diff} placeholder"
				return m, nil
			}
			if !strings.Contains(prPrompt, "{diff}") {
				m.aiPromptsStatus = "PR prompt must contain {diff} placeholder"
				return m, nil
			}

			// Save prompts
			cmd := m.saveAIPrompts(commitPrompt, branchPrompt, prPrompt)
			return m, cmd
		} else if m.aiPromptsModalFocus == 4 {
			// Reset button - show confirmation or just reset
			cmd := m.resetAIPromptsToDefaults()
			return m, cmd
		} else if m.aiPromptsModalFocus == 5 {
			// Cancel button
			m.modal = aiSettingsModal
			m.aiModalFocusedField = 0
			m.aiPromptCommitInput.Blur()
			m.aiPromptBranchInput.Blur()
			m.aiPromptPRInput.Blur()
			return m, nil
		}

	default:
		// Pass keystrokes to the focused text input
		if m.aiPromptsModalFocus == 0 {
			m.aiPromptCommitInput, cmd = m.aiPromptCommitInput.Update(msg)
		} else if m.aiPromptsModalFocus == 1 {
			m.aiPromptBranchInput, cmd = m.aiPromptBranchInput.Update(msg)
		} else if m.aiPromptsModalFocus == 2 {
			m.aiPromptPRInput, cmd = m.aiPromptPRInput.Update(msg)
		}
	}

	return m, cmd
}

// updateAIPromptsInputFocus updates the focus state for AI prompts modal text inputs
func (m *Model) updateAIPromptsInputFocus() {
	// Blur all inputs first
	m.aiPromptCommitInput.Blur()
	m.aiPromptBranchInput.Blur()
	m.aiPromptPRInput.Blur()

	// Focus the selected input
	if m.aiPromptsModalFocus == 0 {
		m.aiPromptCommitInput.Focus()
	} else if m.aiPromptsModalFocus == 1 {
		m.aiPromptBranchInput.Focus()
	} else if m.aiPromptsModalFocus == 2 {
		m.aiPromptPRInput.Focus()
	}
}

func (m Model) handleTmuxConfigModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.modal = settingsModal
		return m, nil

	case "tab", "shift+tab":
		// Check if config exists to determine button count
		hasConfig := false
		if m.sessionManager != nil {
			installed, _ := m.sessionManager.HasJeanTmuxConfig()
			hasConfig = installed
		}

		// If config exists: Update (0), Remove (1), Cancel (2) = 3 buttons
		// If not exists: Install (0), Cancel (1) = 2 buttons
		if hasConfig {
			m.modalFocused = (m.modalFocused + 1) % 3
		} else {
			m.modalFocused = (m.modalFocused + 1) % 2
		}
		return m, nil

	case "enter":
		if m.sessionManager == nil {
			m.modal = settingsModal
			return m, nil
		}

		hasConfig, err := m.sessionManager.HasJeanTmuxConfig()
		if err != nil {
			m.showErrorNotification("Error checking tmux config: " + err.Error(), 3*time.Second)
			m.modal = settingsModal
			return m, nil
		}

		if hasConfig {
			// Config exists: Update (0), Remove (1), Cancel (2)
			switch m.modalFocused {
			case 0:
				// Update button - reinstalls config (remove + add)
				if err := m.sessionManager.AddJeanTmuxConfig(); err != nil {
					m.showErrorNotification("Failed to update tmux config: " + err.Error(), 3*time.Second)
				} else {
					m.showSuccessNotification("jean tmux config updated! New tmux sessions will use the updated config.", 3*time.Second)
				}
			case 1:
				// Remove button
				if err := m.sessionManager.RemoveJeanTmuxConfig(); err != nil {
					m.showErrorNotification("Failed to remove tmux config: " + err.Error(), 3*time.Second)
				} else {
					m.showSuccessNotification("jean tmux config removed. New tmux sessions will use your default config.", 3*time.Second)
				}
			case 2:
				// Cancel button - do nothing
			}
		} else {
			// Config doesn't exist: Install (0), Cancel (1)
			switch m.modalFocused {
			case 0:
				// Install button
				if err := m.sessionManager.AddJeanTmuxConfig(); err != nil {
					m.showErrorNotification("Failed to add tmux config: " + err.Error(), 3*time.Second)
				} else {
					m.showSuccessNotification("jean tmux config installed! New tmux sessions will use this config.", 3*time.Second)
				}
			case 1:
				// Cancel button - do nothing
			}
		}

		// Return to settings modal
		m.modal = settingsModal
		return m, nil
	}

	return m, nil
}

// buildRefreshStatusMessage constructs a detailed status message based on refresh results
func buildRefreshStatusMessage(msg refreshWithPullMsg) string {
	// If everything was already up to date
	if msg.upToDate && len(msg.updatedBranches) == 0 && !msg.mergedBaseBranch {
		return "Already up to date (0 new commits)"
	}

	// Build a summary with commit counts
	var totalCommits int
	var branchDetails []string

	// Add branch-specific updates
	for branch, commits := range msg.updatedBranches {
		if commits > 0 {
			totalCommits += commits
			branchDetails = append(branchDetails, fmt.Sprintf("%s (+%d)", branch, commits))
		}
	}

	// If we merged base branch into worktree, note that
	if msg.mergedBaseBranch && len(branchDetails) > 0 {
		return fmt.Sprintf("Pulled %d commits: %s", totalCommits, strings.Join(branchDetails, ", "))
	} else if msg.mergedBaseBranch {
		return "Merged base branch into worktree"
	}

	// Summary message
	if totalCommits == 0 {
		return "Refreshed (no new commits)"
	}

	if len(branchDetails) == 1 {
		return fmt.Sprintf("Pulled %d new commits in %s", totalCommits, branchDetails[0])
	}

	return fmt.Sprintf("Pulled %d commits: %s", totalCommits, strings.Join(branchDetails, ", "))
}

// handleScriptsModalInput handles input in the scripts selection modal
func (m Model) handleScriptsModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		// Close scripts modal
		m.modal = noModal
		return m, nil

	case "up":
		// Move selection up
		if m.isViewingRunning {
			// In running scripts section
			if m.selectedScriptIdx > 0 {
				m.selectedScriptIdx--
			} else if m.scriptConfig.HasScripts() {
				// Switch to available scripts section at the end
				m.isViewingRunning = false
				m.selectedScriptIdx = len(m.scriptNames) - 1
			}
		} else {
			// In available scripts section
			if m.selectedScriptIdx > 0 {
				m.selectedScriptIdx--
			} else if len(m.runningScripts) > 0 {
				// Switch to running scripts section at the end
				m.isViewingRunning = true
				m.selectedScriptIdx = len(m.runningScripts) - 1
			}
		}
		return m, nil

	case "down":
		// Move selection down
		if m.isViewingRunning {
			// In running scripts section
			if m.selectedScriptIdx < len(m.runningScripts)-1 {
				m.selectedScriptIdx++
			} else if m.scriptConfig.HasScripts() {
				// Switch to available scripts section
				m.isViewingRunning = false
				m.selectedScriptIdx = 0
			}
		} else {
			// In available scripts section
			if m.selectedScriptIdx < len(m.scriptNames)-1 {
				m.selectedScriptIdx++
			} else if len(m.runningScripts) > 0 {
				// Switch to running scripts section
				m.isViewingRunning = true
				m.selectedScriptIdx = 0
			}
		}
		return m, nil

	case "d":
		// Delete/kill running script
		if m.isViewingRunning && m.selectedScriptIdx < len(m.runningScripts) {
			script := &m.runningScripts[m.selectedScriptIdx]
			// Kill the process using syscall
			if !script.finished && script.pid > 0 {
				_ = syscall.Kill(script.pid, syscall.SIGKILL)
				script.finished = true
			}
			// Remove script from list
			m.runningScripts = append(m.runningScripts[:m.selectedScriptIdx], m.runningScripts[m.selectedScriptIdx+1:]...)
			if m.selectedScriptIdx >= len(m.runningScripts) && m.selectedScriptIdx > 0 {
				m.selectedScriptIdx--
			}
			return m, m.showSuccessNotification("Script killed and removed", 2*time.Second)
		}
		return m, nil

	case "enter":
		// Check if selecting a running script or available script
		if m.isViewingRunning && m.selectedScriptIdx < len(m.runningScripts) {
			// Switch to output modal for running script
			m.modal = scriptOutputModal
			m.viewingScriptIdx = m.selectedScriptIdx
			m.viewingScriptName = m.runningScripts[m.selectedScriptIdx].name
			return m, nil
		} else if !m.isViewingRunning && m.selectedScriptIdx < len(m.scriptNames) {
			// Run selected available script
			scriptName := m.scriptNames[m.selectedScriptIdx]
			scriptCmd := m.scriptConfig.GetScript(scriptName)

			wt := m.selectedWorktree()
			if wt == nil {
				m.modal = noModal
				return m, m.showErrorNotification("No worktree selected", 2*time.Second)
			}

			// Create new script execution
			exec := ScriptExecution{
				name:         scriptName,
				command:      scriptCmd,
				output:       "",
				finished:     false,
				startTime:    time.Now(),
				worktreePath: wt.Path,
			}
			m.runningScripts = append(m.runningScripts, exec)

			// Switch to script output modal
			m.modal = scriptOutputModal
			m.viewingScriptIdx = len(m.runningScripts) - 1
			m.viewingScriptName = scriptName

			// Run the script asynchronously (pass the index so we can store process reference)
			scriptIdx := len(m.runningScripts) - 1
			return m, m.runScript(scriptName, scriptCmd, wt.Path, scriptIdx)
		}
		return m, nil
	}

	return m, nil
}

// handleScriptOutputModalInput handles input in the script output modal
func (m Model) handleScriptOutputModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		// Close script output modal and return to scripts modal
		m.modal = scriptsModal
		m.viewingScriptName = ""
		m.viewingScriptIdx = -1
		m.selectedScriptIdx = 0
		return m, nil

	case "k":
		// Kill script (only if still running)
		if m.viewingScriptIdx >= 0 && m.viewingScriptIdx < len(m.runningScripts) {
			script := &m.runningScripts[m.viewingScriptIdx]
			if !script.finished && script.pid > 0 {
				_ = syscall.Kill(script.pid, syscall.SIGKILL)
				script.finished = true
				return m, nil
			}
		}
		return m, nil
	}

	return m, nil
}

func (m Model) handleOnboardingModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		// Skip onboarding
		if err := m.configManager.SetOnboarded(); err != nil {
			m.debugLog(fmt.Sprintf("Failed to save onboarding status: %v", err))
		}
		m.modal = noModal
		return m, nil

	case "tab", "left", "right":
		// Toggle between "Install" and "Skip" buttons
		m.onboardingFocused = (m.onboardingFocused + 1) % 2
		return m, nil

	case "enter":
		if m.onboardingFocused == 0 {
			// Install tmux config
			return m, func() tea.Msg {
				err := m.sessionManager.AddJeanTmuxConfig()
				return tmuxConfigInstalledMsg{err: err}
			}
		} else {
			// Skip - mark onboarding as completed
			if err := m.configManager.SetOnboarded(); err != nil {
				m.debugLog(fmt.Sprintf("Failed to save onboarding status: %v", err))
			}
			m.modal = noModal
			return m, nil
		}
	}

	return m, nil
}

func (m Model) handleHelperModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "h", "q":
		// Close helper modal with Esc, h, or q
		m.modal = noModal
		return m, nil
	}

	return m, nil
}
