package tui

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// View renders the TUI
func (m Model) View() string {
	if !m.ready {
		return "Loading..."
	}

	// Show modal if active
	if m.modal != noModal {
		return m.renderModal()
	}

	// Render main view with panels
	leftPanel := m.renderWorktreeList()
	rightPanel := m.renderDetails()

	// Calculate panel dimensions
	// Allocate more space for help bar (now 2 rows + possible status)
	helpBarHeight := 3 // 2 rows of help + 1 for spacing
	if m.status != "" {
		helpBarHeight = 4 // status + 2 rows of help + spacing
	}

	panelWidth := (m.width - 6) / 2
	panelHeight := m.height - helpBarHeight - 2

	// Style panels
	leftPanelStyled := activePanelStyle.
		Width(panelWidth).
		Height(panelHeight).
		Render(leftPanel)

	rightPanelStyled := panelStyle.
		Width(panelWidth).
		Height(panelHeight).
		Render(rightPanel)

	// Combine panels
	panels := lipgloss.JoinHorizontal(lipgloss.Top, leftPanelStyled, rightPanelStyled)

	// Render help bar
	helpBar := m.renderHelpBar()

	// Combine everything
	return lipgloss.JoinVertical(lipgloss.Left, panels, helpBar)
}

func (m Model) renderWorktreeList() string {
	var b strings.Builder

	repoName := filepath.Base(m.repoPath)
	b.WriteString(titleStyle.Render(fmt.Sprintf("📁 %s", repoName)))
	b.WriteString("\n\n")

	if len(m.worktrees) == 0 {
		b.WriteString(normalItemStyle.Render("No worktrees found"))
		return b.String()
	}

	for i, wt := range m.worktrees {
		var style lipgloss.Style
		icon := "  "

		// Check if this item is selected
		isSelected := i == m.selectedIndex

		if wt.IsCurrent {
			if isSelected {
				// Current worktree AND selected - use selected style with current icon
				style = selectedItemStyle
				icon = "➜ "
			} else {
				// Current worktree but not selected
				style = currentWorktreeStyle
				icon = "➜ "
			}
		} else if isSelected {
			style = selectedItemStyle
			icon = "› "
		} else {
			style = normalItemStyle
			icon = "  "
		}

		// Show branch name and shortened path
		branch := wt.Branch
		if branch == "" {
			branch = "(no branch)"
		}


		// For current worktree, show it's the main repo
		var line string
		if wt.IsCurrent {
			line = fmt.Sprintf("%smain (branch: %s)", icon, branch)
		} else {
			line = fmt.Sprintf("%s%s", icon, branch)

			// Show behind count if outdated
			if wt.IsOutdated && wt.BehindCount > 0 {
				behindIndicator := fmt.Sprintf(" ↓%d", wt.BehindCount)
				line += normalItemStyle.Copy().Foreground(warningColor).Render(behindIndicator)
			}
		}

		b.WriteString(style.Render(line))
		b.WriteString("\n")
	}

	return b.String()
}

func (m Model) renderDetails() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("ℹ️  Details"))
	b.WriteString("\n\n")

	// Show base branch at the top
	if m.baseBranch != "" {
		b.WriteString(detailKeyStyle.Render("Base Branch: "))
		b.WriteString(detailValueStyle.Render(m.baseBranch))
		b.WriteString(normalItemStyle.Copy().Foreground(mutedColor).Render(" (for new worktrees)"))
		b.WriteString("\n\n")
	}

	wt := m.selectedWorktree()
	if wt == nil {
		b.WriteString(normalItemStyle.Render("No worktree selected"))
		return b.String()
	}

	// Render details in a nice format
	details := []struct {
		key   string
		value string
	}{
		{"Branch", wt.Branch},
		{"Path", wt.Path},
		{"Commit", wt.Commit[:min(7, len(wt.Commit))]},
		{"Status", func() string {
			if wt.IsCurrent {
				return "Current"
			}
			return "Available"
		}()},
	}

	for _, d := range details {
		b.WriteString(detailKeyStyle.Render(d.key + ": "))
		b.WriteString(detailValueStyle.Render(d.value))
		b.WriteString("\n")
	}

	// Show branch status vs base branch
	if m.baseBranch != "" && wt.Branch != m.baseBranch && !strings.HasPrefix(wt.Branch, "(detached") {
		b.WriteString("\n")
		b.WriteString(detailKeyStyle.Render("Base Branch Status:"))
		b.WriteString("\n")

		// Show ahead/behind counts
		if wt.AheadCount > 0 || wt.BehindCount > 0 {
			statusParts := []string{}
			if wt.AheadCount > 0 {
				statusParts = append(statusParts, fmt.Sprintf("↑%d ahead", wt.AheadCount))
			}
			if wt.BehindCount > 0 {
				statusParts = append(statusParts, normalItemStyle.Copy().Foreground(warningColor).Render(fmt.Sprintf("↓%d behind", wt.BehindCount)))
			}
			b.WriteString("  " + strings.Join(statusParts, ", "))
			b.WriteString("\n")

			// Show pull hint if behind
			if wt.BehindCount > 0 && !wt.IsCurrent && strings.Contains(wt.Path, ".workspaces") {
				b.WriteString(normalItemStyle.Copy().Foreground(accentColor).Render("  Press 'P' to pull changes from base branch"))
				b.WriteString("\n")
			}
		} else {
			b.WriteString(normalItemStyle.Copy().Foreground(successColor).Render("  ✓ Up to date"))
			b.WriteString("\n")
		}
	}

	// Add extra info
	b.WriteString("\n")
	if wt.IsCurrent {
		b.WriteString(normalItemStyle.Copy().Foreground(mutedColor).Render("You are currently in this worktree"))
	} else {
		b.WriteString(normalItemStyle.Copy().Foreground(accentColor).Render("Press Enter to switch to this worktree"))
	}

	return b.String()
}

func (m Model) renderHelpBar() string {
	if m.err != nil {
		return errorStyle.Render(fmt.Sprintf(" Error: %s ", m.err.Error()))
	}

	var statusLine string
	if m.status != "" {
		statusLine = helpStyle.Render(" " + statusStyle.Render(m.status) + " ")
	}

	// Split keybindings into two rows
	row1 := []string{
		"↑/↓ navigate",
		"n new worktree",
		"a existing branch",
		"o open editor",
		"t terminal",
		"p pull base",
		"P push & PR",
	}

	row2 := []string{
		"r refresh & pull",
		"R rename",
		"d delete",
		"s settings",
		"S sessions",
		"h help",
		"q quit",
	}

	help1 := helpStyle.Render(" " + strings.Join(row1, " • ") + " ")
	help2 := helpStyle.Render(" " + strings.Join(row2, " • ") + " ")

	if statusLine != "" {
		return statusLine + "\n" + help1 + "\n" + help2
	}
	return help1 + "\n" + help2
}

func (m Model) renderModal() string {
	switch m.modal {
	case createModal:
		return m.renderCreateModal()
	case deleteModal:
		return m.renderDeleteModal()
	case branchSelectModal:
		return m.renderBranchSelectModal()
	case checkoutBranchModal:
		return m.renderCheckoutBranchModal()
	case sessionListModal:
		return m.renderSessionListModal()
	case renameModal:
		return m.renderRenameModal()
	case changeBaseBranchModal:
		return m.renderChangeBaseBranchModal()
	case editorSelectModal:
		return m.renderEditorSelectModal()
	case settingsModal:
		return m.renderSettingsModal()
	case tmuxConfigModal:
		return m.renderTmuxConfigModal()
	case helperModal:
		return m.renderHelperModal()
	}
	return ""
}

func (m Model) renderCreateModal() string {
	var b strings.Builder

	title := "Create New Worktree"
	if !m.createNewBranch {
		title = "Create Worktree from Branch"
	}

	b.WriteString(modalTitleStyle.Render(title))
	b.WriteString("\n\n")

	// Branch name input
	if m.createNewBranch {
		b.WriteString(inputLabelStyle.Render("Branch Name:"))
		b.WriteString("\n")
		b.WriteString(m.nameInput.View())
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("(edit the name or press Enter to use generated name)"))
		b.WriteString("\n\n")
	} else {
		b.WriteString(inputLabelStyle.Render("Branch: "))
		b.WriteString(detailValueStyle.Render(m.nameInput.Value()))
		b.WriteString("\n\n")
	}

	// Show info about auto-generated workspace location
	b.WriteString(helpStyle.Render("Workspace location: .workspaces/<random-name>"))
	b.WriteString("\n\n")

	// Buttons (now only 2 buttons: Create and Cancel)
	createBtn := "Create"
	cancelBtn := "Cancel"

	if m.modalFocused == 1 || m.modalFocused == 0 {
		b.WriteString(selectedButtonStyle.Render(createBtn))
	} else {
		b.WriteString(buttonStyle.Render(createBtn))
	}

	if m.modalFocused == 2 {
		b.WriteString(selectedCancelButtonStyle.Render(cancelBtn))
	} else {
		b.WriteString(cancelButtonStyle.Render(cancelBtn))
	}

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Enter to confirm • Esc to cancel"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderDeleteModal() string {
	var b strings.Builder

	wt := m.selectedWorktree()
	if wt == nil {
		return ""
	}

	b.WriteString(modalTitleStyle.Render("Delete Worktree"))
	b.WriteString("\n\n")
	b.WriteString(normalItemStyle.Render(fmt.Sprintf("Are you sure you want to delete worktree:")))
	b.WriteString("\n\n")
	b.WriteString(detailValueStyle.Render(fmt.Sprintf("  Branch: %s", wt.Branch)))
	b.WriteString("\n")
	b.WriteString(detailValueStyle.Render(fmt.Sprintf("  Path: %s", wt.Path)))
	b.WriteString("\n\n")

	// Show warning if there are uncommitted changes
	if m.deleteHasUncommitted {
		b.WriteString(errorStyle.Render("⚠️  WARNING: This worktree has uncommitted changes!"))
		b.WriteString("\n")
		if m.deleteConfirmForce {
			b.WriteString(errorStyle.Render("    Confirm force delete below."))
		} else {
			b.WriteString(errorStyle.Render("    Use 'Force Delete' to proceed anyway."))
		}
		b.WriteString("\n\n")
	} else {
		b.WriteString(errorStyle.Render("This will remove the worktree directory!"))
		b.WriteString("\n\n")
	}

	// Buttons
	if m.deleteHasUncommitted {
		// Show 3 buttons: Yes (disabled), Cancel, Force Delete
		yesBtn := "Yes"
		noBtn := "Cancel"
		forceBtn := "Force Delete"

		// Yes button (disabled if uncommitted changes and not confirmed)
		if m.deleteConfirmForce {
			if m.modalFocused == 0 {
				b.WriteString(selectedDeleteButtonStyle.Render(yesBtn))
			} else {
				b.WriteString(deleteButtonStyle.Render(yesBtn))
			}
		} else {
			// Disabled state
			b.WriteString(disabledButtonStyle.Render(yesBtn))
		}
		b.WriteString("  ")

		// Cancel button
		if m.modalFocused == 1 {
			b.WriteString(selectedButtonStyle.Render(noBtn))
		} else {
			b.WriteString(buttonStyle.Render(noBtn))
		}
		b.WriteString("  ")

		// Force Delete button
		if m.modalFocused == 2 {
			b.WriteString(selectedDeleteButtonStyle.Render(forceBtn))
		} else {
			b.WriteString(deleteButtonStyle.Render(forceBtn))
		}

		b.WriteString("\n\n")
		if m.deleteConfirmForce {
			b.WriteString(helpStyle.Render("Enter/Y to confirm force delete • Esc/N to cancel"))
		} else {
			b.WriteString(helpStyle.Render("Tab/←→ to switch • F or select Force Delete • Esc/N to cancel"))
		}
	} else {
		// Normal delete (no uncommitted changes)
		yesBtn := "Yes, Delete"
		noBtn := "Cancel"

		if m.modalFocused == 0 {
			b.WriteString(selectedDeleteButtonStyle.Render(yesBtn))
		} else {
			b.WriteString(deleteButtonStyle.Render(yesBtn))
		}
		b.WriteString("  ")

		if m.modalFocused == 1 {
			b.WriteString(selectedButtonStyle.Render(noBtn))
		} else {
			b.WriteString(buttonStyle.Render(noBtn))
		}

		b.WriteString("\n\n")
		b.WriteString(helpStyle.Render("Tab/←→ to switch • Enter/Y to confirm • Esc/N to cancel"))
	}

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderBranchSelectModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Select Branch"))
	b.WriteString("\n\n")

	// Search input
	b.WriteString(inputLabelStyle.Render("Search:"))
	b.WriteString("\n")
	b.WriteString(m.searchInput.View())
	b.WriteString("\n\n")

	// Use filtered branches if search is active
	branches := m.branches
	if m.searchInput.Value() != "" {
		branches = m.filteredBranches
	}

	if len(branches) == 0 {
		b.WriteString(normalItemStyle.Render("No branches found"))
		b.WriteString("\n\n")
	} else {
		// Show scrollable branch list
		maxVisible := 10
		start := m.branchIndex - maxVisible/2
		if start < 0 {
			start = 0
		}
		end := start + maxVisible
		if end > len(branches) {
			end = len(branches)
			start = end - maxVisible
			if start < 0 {
				start = 0
			}
		}

		for i := start; i < end; i++ {
			branch := branches[i]
			if i == m.branchIndex {
				b.WriteString(selectedItemStyle.Render(fmt.Sprintf("› %s", branch)))
			} else {
				b.WriteString(normalItemStyle.Render(fmt.Sprintf("  %s", branch)))
			}
			b.WriteString("\n")
		}

		b.WriteString("\n")
		b.WriteString(helpStyle.Render(fmt.Sprintf("Showing %d-%d of %d branches", start+1, end, len(branches))))
		b.WriteString("\n")
	}

	b.WriteString("\n")

	// Buttons
	okBtn := "OK"
	cancelBtn := "Cancel"

	if m.modalFocused == 2 {
		b.WriteString(selectedButtonStyle.Render(okBtn))
	} else {
		b.WriteString(buttonStyle.Render(okBtn))
	}

	if m.modalFocused == 3 {
		b.WriteString(selectedCancelButtonStyle.Render(cancelBtn))
	} else {
		b.WriteString(cancelButtonStyle.Render(cancelBtn))
	}

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("↑↓ navigate • Tab to switch • Enter to select • Esc to cancel"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderCheckoutBranchModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Checkout Branch (Main Repo)"))
	b.WriteString("\n\n")

	// Search input
	b.WriteString(inputLabelStyle.Render("Search:"))
	b.WriteString("\n")
	b.WriteString(m.searchInput.View())
	b.WriteString("\n\n")

	// Use filtered branches if search is active
	branches := m.branches
	if m.searchInput.Value() != "" {
		branches = m.filteredBranches
	}

	if len(branches) == 0 {
		b.WriteString(normalItemStyle.Render("No branches found"))
		b.WriteString("\n\n")
	} else {
		// Show scrollable branch list
		maxVisible := 10
		start := m.branchIndex - maxVisible/2
		if start < 0 {
			start = 0
		}
		end := start + maxVisible
		if end > len(branches) {
			end = len(branches)
			start = end - maxVisible
			if start < 0 {
				start = 0
			}
		}

		for i := start; i < end; i++ {
			branch := branches[i]
			if i == m.branchIndex {
				b.WriteString(selectedItemStyle.Render(fmt.Sprintf("› %s", branch)))
			} else {
				b.WriteString(normalItemStyle.Render(fmt.Sprintf("  %s", branch)))
			}
			b.WriteString("\n")
		}

		b.WriteString("\n")
		b.WriteString(helpStyle.Render(fmt.Sprintf("Showing %d-%d of %d branches", start+1, end, len(branches))))
		b.WriteString("\n")
	}

	b.WriteString("\n")

	// Buttons
	checkoutBtn := "Checkout"
	cancelBtn := "Cancel"

	if m.modalFocused == 2 {
		b.WriteString(selectedButtonStyle.Render(checkoutBtn))
	} else {
		b.WriteString(buttonStyle.Render(checkoutBtn))
	}

	if m.modalFocused == 3 {
		b.WriteString(selectedCancelButtonStyle.Render(cancelBtn))
	} else {
		b.WriteString(cancelButtonStyle.Render(cancelBtn))
	}

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Type to search • ↑↓ navigate • Tab to switch • Enter to checkout • Esc to cancel"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (m Model) renderSessionListModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Active Tmux Sessions"))
	b.WriteString("\n\n")

	if len(m.sessions) == 0 {
		b.WriteString(normalItemStyle.Render("No active gwt sessions found"))
		b.WriteString("\n\n")
		b.WriteString(helpStyle.Render("Press Esc to close"))
	} else {
		// Show sessions
		maxVisible := 10
		start := m.sessionIndex - maxVisible/2
		if start < 0 {
			start = 0
		}
		end := start + maxVisible
		if end > len(m.sessions) {
			end = len(m.sessions)
			start = end - maxVisible
			if start < 0 {
				start = 0
			}
		}

		for i := start; i < end; i++ {
			sess := m.sessions[i]
			statusIcon := "○"
			statusText := ""
			if sess.Active {
				statusIcon = "●"
				statusText = " (attached)"
			}

			var style lipgloss.Style
			if i == m.sessionIndex {
				style = selectedItemStyle
			} else {
				style = normalItemStyle
			}

			line := fmt.Sprintf("%s %s%s", statusIcon, sess.Branch, statusText)
			b.WriteString(style.Render(line))
			b.WriteString("\n")
		}

		b.WriteString("\n")
		b.WriteString(helpStyle.Render(fmt.Sprintf("Showing %d-%d of %d sessions", start+1, end, len(m.sessions))))
		b.WriteString("\n\n")

		b.WriteString(helpStyle.Render("↑↓ navigate • Enter attach • d kill • Esc close"))
	}

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderRenameModal() string {
	var b strings.Builder

	title := "Rename Branch"
	b.WriteString(modalTitleStyle.Render(title))
	b.WriteString("\n\n")

	// Branch name input
	b.WriteString("New branch name:\n")
	inputStyle := normalItemStyle
	if m.modalFocused == 0 {
		inputStyle = selectedItemStyle
	}
	b.WriteString(inputStyle.Render(m.nameInput.View()))
	b.WriteString("\n\n")

	// Buttons
	renameStyle := normalItemStyle
	cancelStyle := normalItemStyle

	if m.modalFocused == 1 {
		renameStyle = selectedItemStyle
	} else if m.modalFocused == 2 {
		cancelStyle = selectedItemStyle
	}

	buttons := lipgloss.JoinHorizontal(
		lipgloss.Left,
		renameStyle.Render("[ Rename ]"),
		"  ",
		cancelStyle.Render("[ Cancel ]"),
	)
	b.WriteString(buttons)

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Tab: cycle • Enter: confirm • Esc: cancel"))

	// Center the modal
	modalContent := b.String()
	modalBox := modalStyle.Render(modalContent)

	// Calculate centering
	modalWidth := lipgloss.Width(modalBox)
	modalHeight := lipgloss.Height(modalBox)

	verticalMargin := (m.height - modalHeight) / 2
	horizontalMargin := (m.width - modalWidth) / 2

	if verticalMargin < 0 {
		verticalMargin = 0
	}
	if horizontalMargin < 0 {
		horizontalMargin = 0
	}

	return lipgloss.Place(
		m.width,
		m.height,
		lipgloss.Center,
		lipgloss.Center,
		modalBox,
	)
}

func (m Model) renderChangeBaseBranchModal() string {
	var b strings.Builder

	title := "Change Base Branch"
	b.WriteString(modalTitleStyle.Render(title))
	b.WriteString("\n\n")

	b.WriteString("All new worktrees will branch from this base branch.\n")
	b.WriteString("Current base: ")
	b.WriteString(selectedItemStyle.Render(m.baseBranch))
	b.WriteString("\n\n")

	// Search input
	b.WriteString(inputLabelStyle.Render("Search:"))
	b.WriteString("\n")
	b.WriteString(m.searchInput.View())
	b.WriteString("\n\n")

	// Use filtered branches if search is active
	branches := m.branches
	if m.searchInput.Value() != "" {
		branches = m.filteredBranches
	}

	if len(branches) == 0 {
		b.WriteString(normalItemStyle.Render("No branches found"))
		b.WriteString("\n\n")
	} else {
		// Show scrollable branch list
		maxVisible := 10
		start := m.branchIndex - maxVisible/2
		if start < 0 {
			start = 0
		}
		end := start + maxVisible
		if end > len(branches) {
			end = len(branches)
			start = end - maxVisible
			if start < 0 {
				start = 0
			}
		}

		for i := start; i < end; i++ {
			branch := branches[i]
			if i == m.branchIndex {
				b.WriteString(selectedItemStyle.Render(fmt.Sprintf("› %s", branch)))
			} else {
				b.WriteString(normalItemStyle.Render(fmt.Sprintf("  %s", branch)))
			}
			b.WriteString("\n")
		}

		b.WriteString("\n")
		b.WriteString(helpStyle.Render(fmt.Sprintf("Showing %d-%d of %d branches", start+1, end, len(branches))))
		b.WriteString("\n")
	}

	b.WriteString("\n")

	// Buttons
	setBtn := "Set"
	cancelBtn := "Cancel"

	if m.modalFocused == 2 {
		b.WriteString(selectedButtonStyle.Render(setBtn))
	} else {
		b.WriteString(buttonStyle.Render(setBtn))
	}

	if m.modalFocused == 3 {
		b.WriteString(selectedCancelButtonStyle.Render(cancelBtn))
	} else {
		b.WriteString(cancelButtonStyle.Render(cancelBtn))
	}

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Type to search • ↑↓ navigate • Tab to switch • Enter to set • Esc to cancel"))

	return lipgloss.Place(
		m.width,
		m.height,
		lipgloss.Center,
		lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderEditorSelectModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Select Editor"))
	b.WriteString("\n\n")

	// Get current editor
	currentEditor := "code"
	if m.configManager != nil {
		currentEditor = m.configManager.GetEditor(m.repoPath)
	}

	b.WriteString(helpStyle.Render(fmt.Sprintf("Current: %s", currentEditor)))
	b.WriteString("\n\n")

	// Show editor list
	for i, editor := range m.editors {
		if i == m.editorIndex {
			b.WriteString(selectedItemStyle.Render(fmt.Sprintf("› %s", editor)))
		} else {
			b.WriteString(normalItemStyle.Render(fmt.Sprintf("  %s", editor)))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("↑↓/jk navigate • Enter to select • Esc to cancel"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderSettingsModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Settings"))
	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Configure gcool settings for this repository"))
	b.WriteString("\n\n")

	// Define settings options
	settings := []struct {
		name        string
		key         string
		description string
		current     string
	}{
		{
			name:        "Editor",
			key:         "e",
			description: "Default editor for opening worktrees",
			current: func() string {
				if m.configManager != nil {
					return m.configManager.GetEditor(m.repoPath)
				}
				return "code"
			}(),
		},
		{
			name:        "Base Branch",
			key:         "c",
			description: "Base branch for creating new worktrees",
			current:     m.baseBranch,
		},
		{
			name:        "Tmux Config",
			key:         "t",
			description: "Add/remove gcool tmux config to ~/.tmux.conf",
			current: func() string {
				if m.sessionManager != nil {
					hasConfig, err := m.sessionManager.HasGcoolTmuxConfig()
					if err == nil && hasConfig {
						return "Installed"
					}
				}
				return "Not installed"
			}(),
		},
	}

	// Render settings list
	for i, setting := range settings {
		var line string
		if i == m.settingsIndex {
			line = selectedItemStyle.Render(fmt.Sprintf("› [%s] %s", setting.key, setting.name))
		} else {
			line = normalItemStyle.Render(fmt.Sprintf("  [%s] %s", setting.key, setting.name))
		}
		b.WriteString(line)
		b.WriteString("\n")

		// Show description and current value
		if i == m.settingsIndex {
			b.WriteString(helpStyle.Render(fmt.Sprintf("    %s", setting.description)))
			b.WriteString("\n")
			b.WriteString(helpStyle.Render(fmt.Sprintf("    Current: %s", setting.current)))
			b.WriteString("\n")
		}
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("↑↓/jk navigate • Enter to configure • Esc to close"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderTmuxConfigModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Tmux Configuration"))
	b.WriteString("\n\n")

	// Check current status
	hasConfig := false
	if m.sessionManager != nil {
		installed, err := m.sessionManager.HasGcoolTmuxConfig()
		if err == nil {
			hasConfig = installed
		}
	}

	if hasConfig {
		b.WriteString(helpStyle.Render("gcool tmux config is currently installed in ~/.tmux.conf"))
		b.WriteString("\n\n")
		b.WriteString(normalItemStyle.Render("Current features:"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • Mouse support for scrolling"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • 10,000 line scrollback buffer"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • 256 color support"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • Ctrl-D to detach from session"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • Improved status bar"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • Better pane border colors"))
		b.WriteString("\n\n")

		// Buttons
		updateBtn := "Update Config"
		removeBtn := "Remove Config"
		cancelBtn := "Cancel"

		if m.modalFocused == 0 {
			b.WriteString(selectedButtonStyle.Render(updateBtn))
		} else {
			b.WriteString(buttonStyle.Render(updateBtn))
		}
		b.WriteString(" ")
		if m.modalFocused == 1 {
			b.WriteString(selectedCancelButtonStyle.Render(removeBtn))
		} else {
			b.WriteString(cancelButtonStyle.Render(removeBtn))
		}
		b.WriteString(" ")
		if m.modalFocused == 2 {
			b.WriteString(selectedCancelButtonStyle.Render(cancelBtn))
		} else {
			b.WriteString(cancelButtonStyle.Render(cancelBtn))
		}
	} else {
		b.WriteString(helpStyle.Render("gcool has an opinionated tmux configuration that includes:"))
		b.WriteString("\n\n")
		b.WriteString(helpStyle.Render("  • Mouse support for scrolling"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • 10,000 line scrollback buffer"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • 256 color support"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • Ctrl-D to detach from session"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • Improved status bar"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("  • Better pane border colors"))
		b.WriteString("\n\n")
		b.WriteString(normalItemStyle.Render("This will be appended to your ~/.tmux.conf in a marked section"))
		b.WriteString("\n")
		b.WriteString(helpStyle.Render("(You can safely delete the section later, or update it from this menu)"))
		b.WriteString("\n\n")

		// Buttons
		installBtn := "Install Config"
		cancelBtn := "Cancel"

		if m.modalFocused == 0 {
			b.WriteString(selectedButtonStyle.Render(installBtn))
		} else {
			b.WriteString(buttonStyle.Render(installBtn))
		}
		b.WriteString(" ")
		if m.modalFocused == 1 {
			b.WriteString(selectedCancelButtonStyle.Render(cancelBtn))
		} else {
			b.WriteString(cancelButtonStyle.Render(cancelBtn))
		}
	}

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Tab to switch • Enter to confirm • Esc to cancel"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderHelperModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("📖 Help - Keybindings"))
	b.WriteString("\n\n")

	// Define keybinding categories
	categories := []struct {
		name        string
		keybindings []struct {
			key         string
			description string
		}
	}{
		{
			name: "Navigation",
			keybindings: []struct {
				key         string
				description string
			}{
				{"↑, k", "Move cursor up"},
				{"↓, j", "Move cursor down"},
			},
		},
		{
			name: "Worktree Management",
			keybindings: []struct {
				key         string
				description string
			}{
				{"n", "Create new worktree with generated branch name"},
				{"a", "Create worktree from existing branch"},
				{"d", "Delete selected worktree"},
				{"enter", "Switch to selected worktree (with Claude)"},
				{"t", "Open terminal in worktree"},
			},
		},
		{
			name: "Branch Operations",
			keybindings: []struct {
				key         string
				description string
			}{
				{"R", "Rename current branch"},
				{"C", "Checkout/switch branch in main repo"},
				{"c", "Change base branch for new worktrees"},
				{"p", "Pull changes from base branch"},
				{"P", "Push & create draft PR"},
			},
		},
		{
			name: "Application",
			keybindings: []struct {
				key         string
				description string
			}{
				{"r", "Refresh & pull latest commits"},
				{"o", "Open worktree in default editor"},
				{"e", "Select default editor"},
				{"s", "Open settings"},
				{"S", "View tmux sessions"},
				{"h", "Show this help"},
				{"q", "Quit application"},
			},
		},
	}

	// Render categories
	for i, category := range categories {
		b.WriteString(detailKeyStyle.Render(category.name))
		b.WriteString("\n")

		for _, kb := range category.keybindings {
			// Format: "  key - description"
			b.WriteString(normalItemStyle.Render(fmt.Sprintf("  %-10s %s", kb.key, "—")))
			b.WriteString(" ")
			b.WriteString(helpStyle.Render(kb.description))
			b.WriteString("\n")
		}

		// Add spacing between categories (except after last one)
		if i < len(categories)-1 {
			b.WriteString("\n")
		}
	}

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Press 'h' or Esc to close this help"))

	// Create a wider modal for better readability
	maxWidth := m.width - 4
	if maxWidth > 120 {
		maxWidth = 120
	}
	content := modalStyle.Width(maxWidth).Render(b.String())

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		content,
	)
}

