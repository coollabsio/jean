package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

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
			m.err = msg.err
			m.status = "Failed to load worktrees"
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.worktrees = msg.worktrees
			m.err = nil
			m.status = ""

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
		}
		return m, nil

	case branchesLoadedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to load branches"
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.branches = msg.branches
			m.err = nil
		}
		return m, nil

	case worktreeCreatedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to create worktree"
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.status = "Worktree created successfully"
			m.modal = noModal

			// Store the newly created branch name for selection after reload
			m.lastCreatedBranch = msg.branch

			// Reload worktrees and select the newly created one
			cmd = m.loadWorktrees

			// Auto-clear status after 2 seconds
			return m, tea.Batch(
				cmd,
				tea.Tick(2*time.Second, func(t time.Time) tea.Msg {
					return clearErrorMsg{}
				}),
			)
		}
		return m, cmd

	case worktreeDeletedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to delete worktree"
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.status = "Worktree deleted successfully"
			m.modal = noModal
			if m.selectedIndex >= len(m.worktrees)-1 {
				m.selectedIndex = len(m.worktrees) - 2
				if m.selectedIndex < 0 {
					m.selectedIndex = 0
				}
			}
			cmd = m.loadWorktrees
		}
		return m, cmd

	case branchRenamedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to rename branch"
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.status = "Branch renamed successfully"
			// Rename tmux sessions to match the new branch name
			cmd = tea.Batch(
				m.renameSessionsForBranch(msg.oldBranch, msg.newBranch),
				m.loadWorktrees,
			)
		}
		return m, cmd

	case branchCheckedOutMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to checkout branch"
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.status = "Branch checked out successfully"
			cmd = m.loadWorktrees
		}
		return m, cmd

	case baseBranchLoadedMsg:
		m.baseBranch = msg.branch
		return m, nil

	case clearErrorMsg:
		m.err = nil
		m.status = ""
		return m, nil

	case statusMsg:
		m.status = string(msg)
		return m, nil

	case sessionsLoadedMsg:
		m.sessions = msg.sessions
		return m, nil

	case editorOpenedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to open editor: " + msg.err.Error()
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.status = "Opened in editor"
			m.err = nil
			// Auto-clear status after 2 seconds
			return m, tea.Tick(2*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		}

	case prCreatedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to create PR: " + msg.err.Error()
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.status = "Draft PR created: " + msg.prURL
			m.err = nil
			// Auto-clear status after 5 seconds
			return m, tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		}

	case commitCreatedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to create commit: " + msg.err.Error()
			// Auto-clear error after 4 seconds
			return m, tea.Tick(4*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			// Show success message with commit hash
			if msg.commitHash != "" {
				hashDisplay := msg.commitHash
				if len(msg.commitHash) > 8 {
					hashDisplay = msg.commitHash[:8]
				}
				m.status = "Commit created: " + hashDisplay
			} else {
				m.status = "Commit created successfully"
			}
			m.err = nil
			// Refresh worktree list to show clean state
			cmd = m.loadWorktrees
			// Auto-clear status after 3 seconds
			return m, tea.Sequence(
				cmd,
				tea.Tick(3*time.Second, func(t time.Time) tea.Msg {
					return clearErrorMsg{}
				}),
			)
		}

	case branchPulledMsg:
		if msg.err != nil {
			m.err = msg.err
			if msg.hadConflict {
				// Show error with abort option
				m.status = "Merge conflict! Run 'git merge --abort' in the worktree to abort."
			} else {
				m.status = "Failed to pull from base branch: " + msg.err.Error()
			}
			// Auto-clear error after 5 seconds
			return m, tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			m.status = "Successfully pulled changes from base branch"
			m.err = nil
			// Refresh worktree list after successful pull
			cmd = m.loadWorktrees
			// Auto-clear status after 2 seconds
			return m, tea.Sequence(
				cmd,
				tea.Tick(2*time.Second, func(t time.Time) tea.Msg {
					return clearErrorMsg{}
				}),
			)
		}

	case refreshWithPullMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "Failed to refresh: " + msg.err.Error()
			// Auto-clear error after 5 seconds
			return m, tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
				return clearErrorMsg{}
			})
		} else {
			// Build detailed status message based on what was pulled
			m.status = buildRefreshStatusMessage(msg)
			m.err = nil
			// Reload worktree list to show updated status
			cmd = m.loadWorktrees
			// Auto-clear status after 2 seconds
			return m, tea.Sequence(
				cmd,
				tea.Tick(2*time.Second, func(t time.Time) tea.Msg {
					return clearErrorMsg{}
				}),
			)
		}

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
	}

	return m, cmd
}

func (m Model) handleMainInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "up", "k":
		if m.selectedIndex > 0 {
			m.selectedIndex--
			// Save the last selected branch
			if wt := m.selectedWorktree(); wt != nil && m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
		}

	case "down", "j":
		if m.selectedIndex < len(m.worktrees)-1 {
			m.selectedIndex++
			// Save the last selected branch
			if wt := m.selectedWorktree(); wt != nil && m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
		}

	case "r":
		m.status = "Pulling latest commits and refreshing..."
		return m, m.refreshWithPull()

	case "n":
		// Instantly create worktree with random branch name from base branch
		randomName, err := m.gitManager.GenerateRandomName()
		if err != nil {
			m.status = "Failed to generate random name"
			return m, nil
		}

		// Generate random path
		path, err := m.gitManager.GetDefaultPath(randomName)
		if err != nil {
			m.status = "Failed to generate workspace path"
			return m, nil
		}

		m.status = "Creating worktree with branch: " + randomName
		return m, m.createWorktree(path, randomName, true)

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
				m.status = "Failed to check for uncommitted changes"
				return m, nil
			}
			m.deleteHasUncommitted = hasUncommitted
			m.deleteConfirmForce = false
			m.modal = deleteModal
			m.modalFocused = 0
			return m, nil
		} else if wt != nil && wt.IsCurrent {
			m.status = "Cannot delete current worktree"
		}

	case "enter":
		// Switch to selected worktree with Claude
		if wt := m.selectedWorktree(); wt != nil {
			// Save the last selected branch before switching
			if m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
			m.switchInfo = SwitchInfo{
				Path:         wt.Path,
				Branch:       wt.Branch,
				AutoClaude:   m.autoClaude,
				TerminalOnly: false, // Explicitly use Claude session, not terminal-only
			}
			return m, tea.Quit
		}

	case "R":
		// Rename current branch (Shift+R)
		if wt := m.selectedWorktree(); wt != nil {
			// Check if this is a workspace worktree (in .workspaces directory)
			if !strings.Contains(wt.Path, ".workspaces") {
				m.status = "Cannot rename main branch. Only workspace branches can be renamed."
				return m, nil
			}
			m.modal = renameModal
			m.modalFocused = 0
			m.nameInput.SetValue(wt.Branch)
			m.nameInput.Focus()
			m.nameInput.CursorEnd()
			return m, nil
		}

	case "B":
		// Checkout/switch branch in main repository (Shift+B for checkout)
		m.modal = checkoutBranchModal
		m.modalFocused = 0
		m.branchIndex = 0
		m.searchInput.SetValue("")
		m.searchInput.Focus()
		m.filteredBranches = nil
		return m, m.loadBranches

	case "t":
		// Open terminal in a separate tmux session (not the Claude session)
		if wt := m.selectedWorktree(); wt != nil {
			// Save the last selected branch before switching
			if m.configManager != nil {
				_ = m.configManager.SetLastSelectedBranch(m.repoPath, wt.Branch)
			}
			m.switchInfo = SwitchInfo{
				Path:         wt.Path,
				Branch:       wt.Branch,
				AutoClaude:   false,        // Never auto-start Claude for terminal
				TerminalOnly: true,         // Signal this is a terminal session
			}
			return m, tea.Quit
		}

	case "o":
		// Open worktree in default IDE
		if wt := m.selectedWorktree(); wt != nil {
			m.status = "Opening in editor..."
			return m, m.openInEditor(wt.Path)
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
		return m, m.loadSessions

	case "p":
		// Pull changes from base branch
		if wt := m.selectedWorktree(); wt != nil {
			// Check if base branch is set
			if m.baseBranch == "" {
				m.status = "Base branch not set. Press 'c' to set base branch"
				return m, nil
			}

			// Only allow pull if worktree is behind
			if !wt.IsOutdated || wt.BehindCount == 0 {
				m.status = "Worktree is already up-to-date with base branch"
				return m, nil
			}

			// Don't allow pull on main worktree
			if !strings.Contains(wt.Path, ".workspaces") {
				m.status = "Cannot pull on main worktree. Use 'git pull' manually."
				return m, nil
			}

			m.status = "Pulling changes from base branch..."
			return m, m.pullFromBaseBranch(wt.Path, m.baseBranch)
		}

	case "P":
		// Create draft PR (push + open PR) (Shift+P)
		if wt := m.selectedWorktree(); wt != nil {
			m.status = "Creating draft PR..."
			return m, m.createPR(wt.Path, wt.Branch)
		}

	case "C":
		// Open commit modal (Shift+C for commit)
		if wt := m.selectedWorktree(); wt != nil {
			// Check if worktree has uncommitted changes
			hasUncommitted, err := m.gitManager.HasUncommittedChanges(wt.Path)
			if err != nil {
				m.err = err
				m.status = "Failed to check for uncommitted changes: " + err.Error()
				// Auto-clear error after 3 seconds
				return m, tea.Tick(3*time.Second, func(t time.Time) tea.Msg {
					return clearErrorMsg{}
				})
			}
			if !hasUncommitted {
				m.status = "Nothing to commit - no uncommitted changes in " + wt.Branch
				// Auto-clear status after 3 seconds
				return m, tea.Tick(3*time.Second, func(t time.Time) tea.Msg {
					return clearErrorMsg{}
				})
			}
			m.modal = commitModal
			m.modalFocused = 0
			m.commitSubjectInput.SetValue("")
			m.commitSubjectInput.Focus()
			m.commitBodyInput.SetValue("")
			return m, nil
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

	case settingsModal:
		return m.handleSettingsModalInput(msg)

	case tmuxConfigModal:
		return m.handleTmuxConfigModalInput(msg)

	case commitModal:
		return m.handleCommitModalInput(msg)

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
		m.modal = noModal
		m.searchInput.Blur()
		return m, nil

	case "up", "k":
		if m.modalFocused == 0 {
			// In search input, move focus to list
			m.modalFocused = 1
			m.searchInput.Blur()
		} else if m.modalFocused == 1 && m.branchIndex > 0 {
			// In list, move selection up
			m.branchIndex--
		}
		return m, nil

	case "down", "j":
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
		isNavigationKey := key == "up" || key == "k" || key == "down" || key == "j" ||
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
		m.modal = noModal
		return m, nil

	case "up", "k":
		if config.getCurrentIndex() > 0 {
			config.decrementIndex(&m)
		}
		return m, nil

	case "down", "j":
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
}

// listSelectionConfig contains configuration for list selection modals
type listSelectionConfig struct {
	getCurrentIndex func() int
	getItemCount    func(m Model) int
	incrementIndex  func(m *Model)
	decrementIndex  func(m *Model)
	onConfirm       func(m Model) (tea.Model, tea.Cmd)
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

func (m Model) handleDeleteModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "n":
		m.modal = noModal
		return m, nil

	case "tab", "left", "right", "h", "l":
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
				m.status = "Press 'y' or Enter to confirm force delete"
				return m, nil
			} else if m.modalFocused == 1 || msg.String() == "n" {
				// User clicked "No" - cancel
				m.modal = noModal
				return m, nil
			} else if m.modalFocused == 0 {
				// User tried to click "Yes" but it's blocked
				m.status = "Cannot delete: uncommitted changes. Use 'Force Delete' to proceed."
				return m, nil
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
			m.status = "Press 'y' or Enter to confirm force delete"
			return m, nil
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
				m.status = "Failed to generate workspace path"
				return m, nil
			}
			return m, m.createWorktree(path, branch, false)
		},
	}
	return m.handleSearchBasedModalInput(msg, config)
}

func (m Model) handleCheckoutBranchModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	config := searchModalConfig{
		onConfirm: func(m Model, branch string) (tea.Model, tea.Cmd) {
			m.status = "Checking out branch: " + branch
			return m, m.checkoutBranch(branch)
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
					m.status = "Failed to attach to session"
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
					m.status = "Failed to kill session"
				} else {
					m.status = "Session killed"
					// Reload sessions
					return m, m.loadSessions
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
		return m, nil

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
				m.status = "Branch name cannot be empty"
				return m, nil
			}

			if wt := m.selectedWorktree(); wt != nil {
				if newName == wt.Branch {
					m.status = "Branch name unchanged"
					m.modal = noModal
					m.nameInput.Blur()
					return m, nil
				}

				m.status = "Renaming branch..."
				m.modal = noModal
				m.nameInput.Blur()
				return m, m.renameBranch(wt.Branch, newName)
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

			// Save to config
			if m.configManager != nil {
				if err := m.configManager.SetBaseBranch(m.repoPath, branch); err != nil {
					m.status = "Base branch set to: " + branch + " (warning: failed to save)"
				} else {
					m.status = "Base branch set to: " + branch + " (saved)"
				}
			} else {
				m.status = "Base branch set to: " + branch
			}
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
				m.status = "Commit subject cannot be empty"
				return m, nil
			}

			body := m.commitBodyInput.Value()
			if wt := m.selectedWorktree(); wt != nil {
				m.status = "Creating commit..."
				m.modal = noModal
				m.commitSubjectInput.Blur()
				m.commitBodyInput.Blur()
				return m, m.createCommit(wt.Path, subject, body)
			}
		} else {
			// Cancel button
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
						m.err = err
						m.status = "Failed to save editor preference"
					} else {
						m.status = "Editor set to: " + selectedEditor
					}
				}
			}
			m.modal = noModal
			return m, nil
		},
	}
	return m.handleListSelectionModalInput(msg, config)
}

func (m Model) handleSettingsModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.modal = noModal
		return m, nil

	case "up", "k":
		if m.settingsIndex > 0 {
			m.settingsIndex--
		}

	case "down", "j":
		if m.settingsIndex < 2 { // Now 3 settings (editor, base branch, tmux config)
			m.settingsIndex++
		}

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
			// Base branch setting - open change base branch modal
			m.modal = changeBaseBranchModal
			m.modalFocused = 0
			m.branchIndex = 0
			m.searchInput.SetValue("")
			m.searchInput.Focus()
			m.filteredBranches = nil
			return m, m.loadBranches

		case 2:
			// Tmux config setting - open tmux config modal
			m.modal = tmuxConfigModal
			m.modalFocused = 0
			return m, nil
		}
	}

	return m, nil
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
			installed, _ := m.sessionManager.HasGcoolTmuxConfig()
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

		hasConfig, err := m.sessionManager.HasGcoolTmuxConfig()
		if err != nil {
			m.status = "Error checking tmux config: " + err.Error()
			m.modal = settingsModal
			return m, nil
		}

		if hasConfig {
			// Config exists: Update (0), Remove (1), Cancel (2)
			switch m.modalFocused {
			case 0:
				// Update button - reinstalls config (remove + add)
				if err := m.sessionManager.AddGcoolTmuxConfig(); err != nil {
					m.status = "Failed to update tmux config: " + err.Error()
				} else {
					m.status = "gcool tmux config updated! New tmux sessions will use the updated config."
				}
			case 1:
				// Remove button
				if err := m.sessionManager.RemoveGcoolTmuxConfig(); err != nil {
					m.status = "Failed to remove tmux config: " + err.Error()
				} else {
					m.status = "gcool tmux config removed. New tmux sessions will use your default config."
				}
			case 2:
				// Cancel button - do nothing
			}
		} else {
			// Config doesn't exist: Install (0), Cancel (1)
			switch m.modalFocused {
			case 0:
				// Install button
				if err := m.sessionManager.AddGcoolTmuxConfig(); err != nil {
					m.status = "Failed to add tmux config: " + err.Error()
				} else {
					m.status = "gcool tmux config installed! New tmux sessions will use this config."
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

func (m Model) handleHelperModalInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "h", "q":
		// Close helper modal with Esc, h, or q
		m.modal = noModal
		return m, nil
	}

	return m, nil
}
