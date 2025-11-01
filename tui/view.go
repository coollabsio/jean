package tui

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/coollabsio/gcool/config"
	"github.com/coollabsio/gcool/session"
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
	panelHeight := m.height - 4 // Reserve space for help bar (2 lines) + top spacing (2 lines)

	panelWidth := (m.width - 6) / 2

	// Style panels
	leftPanelStyled := activePanelStyle.
		Width(panelWidth).
		Height(panelHeight).
		Render(leftPanel)

	rightPanelStyled := panelStyle.
		Width(panelWidth).
		Height(panelHeight).
		Render(rightPanel)

	// Combine panels horizontally
	panels := lipgloss.JoinHorizontal(lipgloss.Top, leftPanelStyled, rightPanelStyled)

	// Add minimal help bar at the bottom with top spacing for border visibility
	helpBar := m.renderMinimalHelpBar()
	mainView := lipgloss.JoinVertical(lipgloss.Left, "\n", panels, helpBar)

	// If notification exists, render it as an overlay on top of panels
	if m.notification != nil {
		notification := m.renderNotification()
		// Position notification at the bottom center as an overlay
		return m.renderNotificationOverlay(mainView, notification)
	}

	return mainView
}

func (m Model) renderWorktreeList() string {
	var b strings.Builder

	repoName := filepath.Base(m.repoPath)
	b.WriteString(titleStyle.Render(fmt.Sprintf("📁 %s", repoName)))
	b.WriteString("\n")

	// Show base branch info
	if m.baseBranch != "" {
		b.WriteString(normalItemStyle.Copy().Foreground(mutedColor).Render(fmt.Sprintf("Base: %s (press 'b' to change)", m.baseBranch)))
		b.WriteString("\n\n")
	} else {
		b.WriteString("\n")
	}

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
			line = fmt.Sprintf("%sroot (branch: %s)", icon, branch)
		} else {
			line = fmt.Sprintf("%s%s", icon, branch)

			// Show uncommitted changes indicator
			if wt.HasUncommitted {
				uncommittedIndicator := " ●"
				line += normalItemStyle.Copy().Foreground(warningColor).Render(uncommittedIndicator)
			}

			// Show behind count if outdated
			if wt.IsOutdated && wt.BehindCount > 0 {
				behindIndicator := fmt.Sprintf(" ↓%d", wt.BehindCount)
				line += normalItemStyle.Copy().Foreground(warningColor).Render(behindIndicator)
			}
		}

		// Show Claude status indicator
		if status, exists := m.claudeStatuses[wt.ClaudeSessionName]; exists {
			var statusIndicator string
			if status == session.StatusBusy {
				// Animated spinner for busy state
				spinners := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
				frame := m.claudeStatusFrame % len(spinners)
				statusIndicator = normalItemStyle.Copy().Foreground(busyColor).Render(" " + spinners[frame])
			} else if status == session.StatusReady {
				// Green dot for ready state
				statusIndicator = normalItemStyle.Copy().Foreground(readyColor).Render(" ●")
			}
			line += statusIndicator
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

	wt := m.selectedWorktree()
	if wt == nil {
		b.WriteString(normalItemStyle.Render("No worktree selected"))
		return b.String()
	}

	// Render details in a nice format
	b.WriteString(detailKeyStyle.Render("Branch: "))
	b.WriteString(detailValueStyle.Render(wt.Branch))
	b.WriteString("\n")

	// Show base branch right after branch
	if m.baseBranch != "" {
		b.WriteString(detailKeyStyle.Render("Base Branch: "))
		b.WriteString(detailValueStyle.Render(m.baseBranch))

		// Show status on the same line if branch differs from base branch
		if wt.Branch != m.baseBranch && !strings.HasPrefix(wt.Branch, "(detached") {
			b.WriteString("  ")
			// Show ahead/behind counts
			if wt.AheadCount > 0 || wt.BehindCount > 0 {
				statusParts := []string{}
				if wt.AheadCount > 0 {
					statusParts = append(statusParts, fmt.Sprintf("↑%d ahead", wt.AheadCount))
				}
				if wt.BehindCount > 0 {
					statusParts = append(statusParts, normalItemStyle.Copy().Foreground(warningColor).Render(fmt.Sprintf("↓%d behind", wt.BehindCount)))
				}
				b.WriteString(strings.Join(statusParts, ", "))

				// Add pull hint directly on the same line if behind
				if wt.BehindCount > 0 && !wt.IsCurrent && strings.Contains(wt.Path, ".workspaces") {
					b.WriteString(normalItemStyle.Copy().Foreground(mutedColor).Render(" (press 'u' to pull)"))
				}
			} else {
				b.WriteString(normalItemStyle.Copy().Foreground(successColor).Render("✓ Up to date"))
			}
		}
		b.WriteString("\n")
	}

	details := []struct {
		key   string
		value string
	}{
		{"Path", wt.Path},
		{"Commit", wt.Commit[:min(7, len(wt.Commit))]},
	}

	for _, d := range details {
		b.WriteString(detailKeyStyle.Render(d.key + ": "))
		b.WriteString(detailValueStyle.Render(d.value))
		b.WriteString("\n")
	}

	// Show uncommitted changes status
	if wt.HasUncommitted {
		b.WriteString("\n")
		b.WriteString(detailKeyStyle.Render("Git Status:"))
		b.WriteString("\n")
		b.WriteString(normalItemStyle.Copy().Foreground(warningColor).Render("  ● Uncommitted changes"))
		b.WriteString("\n")
		b.WriteString(normalItemStyle.Copy().Foreground(accentColor).Render("  Press 'c' to commit"))
		b.WriteString("\n")
	}

	// Show Claude status
	if status, exists := m.claudeStatuses[wt.ClaudeSessionName]; exists {
		b.WriteString("\n")
		b.WriteString(detailKeyStyle.Render("Claude Status:"))
		b.WriteString("\n")
		if status == session.StatusBusy {
			spinners := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
			frame := m.claudeStatusFrame % len(spinners)
			statusText := normalItemStyle.Copy().Foreground(busyColor).Render(fmt.Sprintf("  %s Busy", spinners[frame]))
			b.WriteString(statusText)
		} else if status == session.StatusReady {
			statusText := normalItemStyle.Copy().Foreground(readyColor).Render("  ● Ready")
			b.WriteString(statusText)
		}
		b.WriteString("\n")
	}

	// Show PR status
	if prs, ok := wt.PRs.([]config.PRInfo); ok && len(prs) > 0 {
		b.WriteString("\n")
		b.WriteString(detailKeyStyle.Render("Pull Requests:"))
		b.WriteString("\n")
		for i, pr := range prs {
			// Determine status emoji
			statusEmoji := "🟢"
			statusColor := successColor
			switch pr.Status {
			case "merged":
				statusEmoji = "🟣"
				statusColor = successColor
			case "closed":
				statusEmoji = "⚫"
				statusColor = warningColor
			}

			// Extract PR number from URL if possible (last part of URL)
			prDisplay := pr.URL
			if strings.Contains(pr.URL, "/pull/") {
				parts := strings.Split(pr.URL, "/pull/")
				if len(parts) > 1 {
					prNum := strings.Split(parts[1], "/")[0]
					prDisplay = "#" + prNum
				}
			}

			b.WriteString("  ")
			b.WriteString(normalItemStyle.Copy().Foreground(statusColor).Render(statusEmoji))
			b.WriteString(" ")
			// Render PR as underlined text with OSC 8 hyperlink support for modern terminals
			styledPR := normalItemStyle.Copy().Foreground(accentColor).Underline(true).Render(prDisplay)
			// Add OSC 8 hyperlink codes around the styled text
			b.WriteString(fmt.Sprintf("\033]8;;%s\033\\%s\033]8;;\033\\", pr.URL, styledPR))
			if i < len(prs)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
	}

	// Add action hints
	b.WriteString("\n")
	b.WriteString(detailKeyStyle.Render("Actions:"))
	b.WriteString("\n")

	b.WriteString(normalItemStyle.Copy().Foreground(accentColor).Render("  t for open terminal"))
	b.WriteString("\n")
	// Get the default editor
	editor := "code"
	if m.configManager != nil {
		editor = m.configManager.GetEditor(m.repoPath)
	}
	b.WriteString(normalItemStyle.Copy().Foreground(accentColor).Render(fmt.Sprintf("  o open in default editor (%s)", editor)))
	b.WriteString("\n")
	b.WriteString(normalItemStyle.Copy().Foreground(accentColor).Render("  Enter to start Claude"))

	return b.String()
}

func (m Model) renderNotification() string {
	if m.notification == nil {
		return ""
	}

	// Determine icon based on notification type
	var icon string
	var style lipgloss.Style
	switch m.notification.Type {
	case NotificationSuccess:
		icon = "✓"
		style = successNotifStyle
	case NotificationError:
		icon = "✗"
		style = errorNotifStyle
	case NotificationWarning:
		icon = "⚠"
		style = warningNotifStyle
	case NotificationInfo:
		icon = "ℹ"
		style = infoNotifStyle
	default:
		icon = "•"
		style = infoNotifStyle
	}

	message := fmt.Sprintf("%s %s", icon, m.notification.Message)
	// Apply width (60% of screen width), padding, and ensure border is visible
	notifWidth := int(float64(m.width) * 0.6)
	if notifWidth < 40 {
		notifWidth = 40
	}
	return style.
		Width(notifWidth).
		Padding(0, 1).
		Render(message)
}

// renderNotificationOverlay renders the notification as an overlay on top of the main view
func (m Model) renderNotificationOverlay(baseView, notification string) string {
	// Split the base view into lines
	lines := strings.Split(baseView, "\n")

	// Get notification dimensions
	notificationLines := strings.Split(notification, "\n")
	notificationWidth := lipgloss.Width(notification)

	// Calculate position: bottom with padding (last few lines)
	positionY := len(lines) - len(notificationLines) - 1
	if positionY < 0 {
		positionY = 0
	}

	// Center horizontally - add padding to center the notification
	leftPadding := (m.width - notificationWidth) / 2
	if leftPadding < 0 {
		leftPadding = 0
	}

	// Build the output by overlaying notification (replace lines, don't add)
	var output strings.Builder
	for i, line := range lines {
		if i >= positionY && i < positionY+len(notificationLines) {
			// Replace this line with notification line
			notifLineIdx := i - positionY
			if notifLineIdx < len(notificationLines) {
				paddingStr := strings.Repeat(" ", leftPadding)
				output.WriteString(paddingStr)
				output.WriteString(notificationLines[notifLineIdx])
				output.WriteString("\n")
			}
		} else {
			// Write the original line
			output.WriteString(line)
			output.WriteString("\n")
		}
	}

	return strings.TrimRight(output.String(), "\n")
}

func (m Model) renderMinimalHelpBar() string {
	var b strings.Builder

	keybindings := []string{
		"↑/↓ nav",
		"n new",
		"enter/t cli/terminal",
		"c commit",
		"g github",
		"p push",
		"h help",
		"q quit",
	}

	helpText := strings.Join(keybindings, " • ")
	b.WriteString(helpStyle.Render(helpText))

	return b.String()
}

func (m Model) renderModal() string {
	switch m.modal {
	case createModal:
		return m.renderCreateModal()
	case createWithNameModal:
		return m.renderCreateWithNameModal()
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
	case aiSettingsModal:
		return m.renderAISettingsModal()
	case tmuxConfigModal:
		return m.renderTmuxConfigModal()
	case themeSelectModal:
		return m.renderThemeSelectModal()
	case commitModal:
		return m.renderCommitModal()
	case prContentModal:
		return m.renderPRContentModal()
	case prListModal:
		return m.renderPRListModal()
	case mergeStrategyModal:
		return m.renderMergeStrategyModal()
	case helperModal:
		return m.renderHelperModal()
	case scriptsModal:
		return m.renderScriptsModal()

	case scriptOutputModal:
		return m.renderScriptOutputModal()
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

func (m Model) renderCreateWithNameModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Create New Worktree"))
	b.WriteString("\n\n")

	// Session name input (pre-filled with random name)
	b.WriteString(inputLabelStyle.Render("Session Name:"))
	b.WriteString("\n")

	// Show focused or unfocused input
	if m.modalFocused == 0 {
		b.WriteString(m.sessionNameInput.View())
	} else {
		// When not focused, show the input value as plain text
		inputValue := m.sessionNameInput.Value()
		if inputValue == "" {
			inputValue = m.sessionNameInput.Placeholder
		}
		b.WriteString(detailValueStyle.Render(inputValue))
	}
	b.WriteString("\n")
	b.WriteString(helpStyle.Render("(customize the name or use the default)"))
	b.WriteString("\n\n")

	// Show info about what will be created
	sessionName := m.sessionNameInput.Value()
	sanitizedName := m.sessionManager.SanitizeBranchName(sessionName)

	b.WriteString(helpStyle.Render(fmt.Sprintf("Will create:")))
	b.WriteString("\n")
	b.WriteString(helpStyle.Render(fmt.Sprintf("  Branch: %s", sanitizedName)))
	b.WriteString("\n")
	b.WriteString(helpStyle.Render(fmt.Sprintf("  Claude will automatically continue previous conversations")))

	// Show sanitization notice if name was changed
	if sanitizedName != sessionName && sessionName != "" {
		b.WriteString("\n")
		b.WriteString(helpStyle.Render(fmt.Sprintf("  (sanitized from '%s')", sessionName)))
	}
	b.WriteString("\n\n")

	// Buttons (Create and Cancel)
	createBtn := "Create"
	cancelBtn := "Cancel"

	if m.modalFocused == 1 {
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
	b.WriteString(helpStyle.Render("Tab to navigate • Enter to confirm • Esc to cancel"))

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

			// Determine session type
			sessionTypeIcon := "🤖"  // Claude session (default)
			if strings.HasSuffix(sess.Name, "-terminal") {
				sessionTypeIcon = "⌨️ " // Terminal session
			}

			var style lipgloss.Style
			if i == m.sessionIndex {
				style = selectedItemStyle
			} else {
				style = normalItemStyle
			}

			line := fmt.Sprintf("%s %s %s%s", statusIcon, sessionTypeIcon, sess.Branch, statusText)
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

	// Spinner or status message
	if m.generatingRename {
		// Show spinner animation while generating
		spinnerFrames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		spinner := spinnerFrames[m.renameSpinnerFrame%10]
		b.WriteString(statusStyle.Render(spinner + " Generating branch name from changes..."))
		b.WriteString("\n\n")
	} else if m.renameModalStatus != "" {
		if strings.Contains(m.renameModalStatus, "❌") {
			b.WriteString(errorStyle.Render(m.renameModalStatus))
		} else {
			b.WriteString(statusStyle.Render(m.renameModalStatus))
		}
		b.WriteString("\n\n")
	}

	// AI hint
	hasAIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
	if hasAIKey {
		b.WriteString(helpStyle.Render("💡 Press 'g' to generate branch name from changes"))
		b.WriteString("\n\n")
	}

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
	b.WriteString(helpStyle.Render("Tab: cycle • Enter: confirm • g: generate • Esc: cancel"))

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

func (m Model) renderCommitModal() string {
	var b strings.Builder

	title := "Commit Changes"
	b.WriteString(modalTitleStyle.Render(title))
	b.WriteString("\n\n")

	// Subject input
	b.WriteString(inputLabelStyle.Render("Subject (required):"))
	b.WriteString("\n")
	subjectStyle := normalItemStyle
	if m.modalFocused == 0 {
		subjectStyle = selectedItemStyle
	}
	b.WriteString(subjectStyle.Render(m.commitSubjectInput.View()))
	b.WriteString("\n\n")

	// Body input
	b.WriteString(inputLabelStyle.Render("Body (optional):"))
	b.WriteString("\n")
	bodyStyle := normalItemStyle
	if m.modalFocused == 1 {
		bodyStyle = selectedItemStyle
	}
	b.WriteString(bodyStyle.Render(m.commitBodyInput.View()))
	b.WriteString("\n\n")

	// Status message (error or success from AI generation) or spinner
	if m.generatingCommit {
		// Show spinner animation while generating
		spinnerFrames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		spinner := spinnerFrames[m.spinnerFrame%10]
		b.WriteString(statusStyle.Render(spinner + " Generating commit message with AI..."))
		b.WriteString("\n\n")
	} else if m.commitModalStatus != "" {
		if strings.Contains(m.commitModalStatus, "❌") {
			b.WriteString(errorStyle.Render(m.commitModalStatus))
		} else {
			b.WriteString(statusStyle.Render(m.commitModalStatus))
		}
		b.WriteString("\n\n")
	}

	// AI availability indicator
	hasAIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
	if hasAIKey {
		b.WriteString(helpStyle.Render("💡 Press 'g' to generate commit message with AI"))
		b.WriteString("\n\n")
	} else {
		b.WriteString(helpStyle.Render("💡 Tip: Enable AI in settings (s → a) to auto-generate commit messages"))
		b.WriteString("\n\n")
	}

	// Buttons
	commitStyle := normalItemStyle
	cancelStyle := normalItemStyle

	if m.modalFocused == 2 {
		commitStyle = selectedItemStyle
	} else if m.modalFocused == 3 {
		cancelStyle = selectedItemStyle
	}

	buttons := lipgloss.JoinHorizontal(
		lipgloss.Left,
		commitStyle.Render("[ Commit ]"),
		"  ",
		cancelStyle.Render("[ Cancel ]"),
	)
	b.WriteString(buttons)

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Tab: next field • Enter: confirm/move • Esc: cancel"))

	// Center the modal
	modalContent := b.String()
	modalBox := modalStyle.Render(modalContent)

	return lipgloss.Place(
		m.width,
		m.height,
		lipgloss.Center,
		lipgloss.Center,
		modalBox,
	)
}

func (m Model) renderPRContentModal() string {
	var b strings.Builder

	title := "Create Pull Request"
	b.WriteString(modalTitleStyle.Render(title))
	b.WriteString("\n\n")

	// Title input
	b.WriteString(inputLabelStyle.Render("Title (required):"))
	b.WriteString("\n")
	titleStyle := normalItemStyle
	if m.prModalFocused == 0 {
		titleStyle = selectedItemStyle
	}
	b.WriteString(titleStyle.Render(m.prTitleInput.View()))
	b.WriteString("\n\n")

	// Description input
	b.WriteString(inputLabelStyle.Render("Description (optional):"))
	b.WriteString("\n")
	descriptionStyle := normalItemStyle
	if m.prModalFocused == 1 {
		descriptionStyle = selectedItemStyle
	}
	b.WriteString(descriptionStyle.Render(m.prDescriptionInput.View()))
	b.WriteString("\n\n")

	// Spinner or status message
	if m.generatingPRContent {
		// Show spinner animation while generating
		spinnerFrames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		spinner := spinnerFrames[m.prSpinnerFrame%10]
		b.WriteString(statusStyle.Render(spinner + " Generating PR content with AI..."))
		b.WriteString("\n\n")
	}

	// AI hint
	hasAIKey := m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != ""
	if hasAIKey {
		b.WriteString(helpStyle.Render("💡 Press 'g' to auto-generate PR content with AI"))
		b.WriteString("\n\n")
	} else {
		b.WriteString(helpStyle.Render("💡 Tip: Enable AI in settings (s → a) to auto-generate PR content"))
		b.WriteString("\n\n")
	}

	// Buttons
	createStyle := normalItemStyle
	cancelStyle := normalItemStyle

	if m.prModalFocused == 2 {
		createStyle = selectedItemStyle
	} else if m.prModalFocused == 3 {
		cancelStyle = selectedItemStyle
	}

	buttons := lipgloss.JoinHorizontal(
		lipgloss.Left,
		createStyle.Render("[ Create PR ]"),
		"  ",
		cancelStyle.Render("[ Cancel ]"),
	)
	b.WriteString(buttons)

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Tab: next field • Enter: confirm/move • Esc: cancel"))

	// Center the modal
	modalContent := b.String()
	modalBox := modalStyle.Render(modalContent)

	return lipgloss.Place(
		m.width,
		m.height,
		lipgloss.Center,
		lipgloss.Center,
		modalBox,
	)
}

func (m Model) renderPRListModal() string {
	var b strings.Builder

	// Handle error case
	if m.prLoadingError != "" {
		b.WriteString(modalTitleStyle.Render("Select PR to Create Worktree"))
		b.WriteString("\n\n")
		b.WriteString(errorStyle.Render("Error: " + m.prLoadingError))
		b.WriteString("\n\n")
		b.WriteString(helpStyle.Render("Press Esc to close"))
		return lipgloss.Place(
			m.width, m.height,
			lipgloss.Center, lipgloss.Center,
			modalStyle.Render(b.String()),
		)
	}

	// Handle loading case (no PRs loaded yet)
	if len(m.prs) == 0 {
		if len(m.filteredPRs) == 0 {
			b.WriteString(modalTitleStyle.Render("Select PR to Create Worktree"))
			b.WriteString("\n\n")
			b.WriteString(helpStyle.Render("Loading pull requests..."))
			b.WriteString("\n\n")
			b.WriteString(helpStyle.Render("Press Esc to cancel"))
			return lipgloss.Place(
				m.width, m.height,
				lipgloss.Center, lipgloss.Center,
				modalStyle.Render(b.String()),
			)
		}
	}

	b.WriteString(modalTitleStyle.Render("Select PR to Create Worktree"))
	b.WriteString("\n\n")

	// Search input
	if m.modalFocused == 0 {
		b.WriteString(inputLabelStyle.Render("Search:"))
	} else {
		b.WriteString(helpStyle.Render("Search:"))
	}
	b.WriteString("\n")
	b.WriteString(m.prSearchInput.View())
	b.WriteString("\n\n")

	// Show filtered PRs list
	filteredPRs := m.filterPRs(m.prSearchInput.Value())

	if len(filteredPRs) == 0 {
		if m.prSearchInput.Value() != "" {
			b.WriteString(helpStyle.Render("No PRs matching search"))
		} else {
			b.WriteString(helpStyle.Render("No open pull requests found"))
		}
	} else {
		// Calculate max lines for list (leave room for header, search, buttons, help)
		maxLines := m.height - 15
		startIdx := 0
		if m.prListIndex >= maxLines {
			startIdx = m.prListIndex - maxLines + 1
		}

		endIdx := startIdx + maxLines
		if endIdx > len(filteredPRs) {
			endIdx = len(filteredPRs)
		}

		// Show subset of PRs
		for i := startIdx; i < endIdx; i++ {
			pr := filteredPRs[i]
			displayIdx := i - startIdx

			// Format: #123 - Title (by @author) [branch]
			line := fmt.Sprintf("#%d - %s (by @%s) [%s]",
				pr.Number,
				pr.Title,
				pr.Author.Login,
				pr.HeadRefName,
			)

			if displayIdx+startIdx == m.prListIndex {
				b.WriteString(selectedItemStyle.Render("› " + line))
			} else {
				b.WriteString(normalItemStyle.Render("  " + line))
			}
			b.WriteString("\n")
		}
	}

	b.WriteString("\n")

	// Buttons
	okBtn := " OK "
	cancelBtn := " Cancel "

	if m.modalFocused == 2 {
		b.WriteString(selectedButtonStyle.Render(okBtn))
	} else {
		b.WriteString(buttonStyle.Render(okBtn))
	}
	b.WriteString(" ")
	if m.modalFocused == 3 {
		b.WriteString(selectedCancelButtonStyle.Render(cancelBtn))
	} else {
		b.WriteString(cancelButtonStyle.Render(cancelBtn))
	}

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("↑↓ navigate • Enter to create • Tab to focus • Esc to cancel"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
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
	b.WriteString(helpStyle.Render("↑↓ navigate • Enter to select • Esc to cancel"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderThemeSelectModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Select Theme"))
	b.WriteString("\n\n")

	// Get current theme
	currentTheme := m.configManager.GetTheme(m.repoPath)

	b.WriteString(helpStyle.Render(fmt.Sprintf("Current: %s", currentTheme)))
	b.WriteString("\n\n")

	// Show theme list
	for i, theme := range m.availableThemes {
		if i == m.themeIndex {
			line := fmt.Sprintf("› %s - %s", theme.Name, theme.Description)
			b.WriteString(selectedItemStyle.Render(line))
		} else {
			line := fmt.Sprintf("  %s - %s", theme.Name, theme.Description)
			b.WriteString(normalItemStyle.Render(line))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("↑↓ navigate • Enter to select • Esc to cancel"))

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

	// Define settings options (without computing current values yet)
	settings := []struct {
		name        string
		key         string
		description string
		getCurrent  func() string // Function to get current value dynamically
	}{
		{
			name:        "Editor",
			key:         "e",
			description: "Default editor for opening worktrees",
			getCurrent: func() string {
				if m.configManager != nil {
					return m.configManager.GetEditor(m.repoPath)
				}
				return "code"
			},
		},
		{
			name:        "Theme",
			key:         "h",
			description: "Change UI theme (matrix, coolify, dracula, nord, solarized)",
			getCurrent: func() string {
				if m.configManager != nil {
					return m.configManager.GetTheme(m.repoPath)
				}
				return "matrix"
			},
		},
		{
			name:        "Base Branch",
			key:         "c",
			description: "Base branch for creating new worktrees",
			getCurrent: func() string {
				return m.baseBranch
			},
		},
		{
			name:        "Tmux Config",
			key:         "t",
			description: "Add/remove gcool tmux config to ~/.tmux.conf",
			getCurrent: func() string {
				if m.sessionManager != nil {
					hasConfig, err := m.sessionManager.HasGcoolTmuxConfig()
					if err == nil && hasConfig {
						return "Installed"
					}
				}
				return "Not installed"
			},
		},
		{
			name:        "AI Integration",
			key:         "a",
			description: "Configure OpenRouter API for AI-powered commit messages and branch names",
			getCurrent: func() string {
				if m.configManager != nil && m.configManager.GetOpenRouterAPIKey() != "" {
					return "Configured"
				}
				return "Not configured"
			},
		},
		{
			name:        "Debug Logs",
			key:         "d",
			description: "Enable/disable debug logging to /tmp/gcool-*.log files",
			getCurrent: func() string {
				if m.configManager != nil {
					if m.configManager.GetDebugLoggingEnabled() {
						return "Enabled"
					}
				}
				return "Disabled"
			},
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
			b.WriteString(helpStyle.Render(fmt.Sprintf("    Current: %s", setting.getCurrent())))
			b.WriteString("\n")
		}
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("↑↓ navigate • Enter to configure • Esc to close"))

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		modalStyle.Render(b.String()),
	)
}

func (m Model) renderAISettingsModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("AI Integration Settings"))
	b.WriteString("\n\n")

	// API Key input
	apiKeyLabel := "OpenRouter API Key:"
	if m.aiModalFocusedField == 0 {
		apiKeyLabel = selectedItemStyle.Render(apiKeyLabel)
	} else {
		apiKeyLabel = inputLabelStyle.Render(apiKeyLabel)
	}
	b.WriteString(apiKeyLabel)
	b.WriteString("\n")
	b.WriteString(m.aiAPIKeyInput.View())
	b.WriteString("\n\n")

	// Model selection
	modelLabel := "Model:"
	if m.aiModalFocusedField == 1 {
		modelLabel = selectedItemStyle.Render(modelLabel)
	} else {
		modelLabel = inputLabelStyle.Render(modelLabel)
	}
	b.WriteString(modelLabel)
	b.WriteString("\n")
	for i, model := range m.aiModels {
		if i == m.aiModelIndex {
			b.WriteString(selectedItemStyle.Render(fmt.Sprintf("› %s", model)))
		} else {
			b.WriteString(normalItemStyle.Render(fmt.Sprintf("  %s", model)))
		}
		b.WriteString("\n")
	}
	b.WriteString("\n")

	// AI Commit toggle
	aiCommitLabel := "Enable AI commit messages:"
	if m.aiModalFocusedField == 2 {
		aiCommitLabel = selectedItemStyle.Render(aiCommitLabel)
	} else {
		aiCommitLabel = inputLabelStyle.Render(aiCommitLabel)
	}
	b.WriteString(aiCommitLabel)
	b.WriteString("\n")
	aiCommitStatus := "Off"
	if m.aiCommitEnabled {
		aiCommitStatus = selectedItemStyle.Render("✓ On")
	} else {
		aiCommitStatus = normalItemStyle.Render("  Off")
	}
	b.WriteString(aiCommitStatus)
	b.WriteString("\n\n")

	// AI Branch name toggle
	aiBranchLabel := "Enable AI branch names:"
	if m.aiModalFocusedField == 3 {
		aiBranchLabel = selectedItemStyle.Render(aiBranchLabel)
	} else {
		aiBranchLabel = inputLabelStyle.Render(aiBranchLabel)
	}
	b.WriteString(aiBranchLabel)
	b.WriteString("\n")
	aiBranchStatus := "Off"
	if m.aiBranchNameEnabled {
		aiBranchStatus = selectedItemStyle.Render("✓ On")
	} else {
		aiBranchStatus = normalItemStyle.Render("  Off")
	}
	b.WriteString(aiBranchStatus)
	b.WriteString("\n\n")

	// Status message (error or success from API test)
	if m.aiModalStatus != "" {
		if strings.Contains(m.aiModalStatus, "❌") {
			b.WriteString(errorStyle.Render(m.aiModalStatus))
		} else {
			b.WriteString(statusStyle.Render(m.aiModalStatus))
		}
		b.WriteString("\n\n")
	}

	// Buttons
	testStyle := buttonStyle
	saveStyle := buttonStyle
	cancelStyle := cancelButtonStyle
	clearStyle := cancelButtonStyle

	if m.aiModalFocusedField == 4 {
		testStyle = selectedButtonStyle
	} else if m.aiModalFocusedField == 5 {
		saveStyle = selectedButtonStyle
	} else if m.aiModalFocusedField == 6 {
		cancelStyle = selectedCancelButtonStyle
	} else if m.aiModalFocusedField == 7 {
		clearStyle = selectedCancelButtonStyle
	}

	b.WriteString(testStyle.Render("[ Test Key ]"))
	b.WriteString("  ")
	b.WriteString(saveStyle.Render("[ Save ]"))
	b.WriteString("  ")
	b.WriteString(cancelStyle.Render("[ Cancel ]"))
	b.WriteString("  ")
	b.WriteString(clearStyle.Render("[ Clear ]"))

	b.WriteString("\n\n")
	b.WriteString(helpStyle.Render("Tab: next field • Enter: confirm • Esc: cancel"))

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
			name: "Worktree & Navigation",
			keybindings: []struct {
				key         string
				description string
			}{
				{"↑", "Move cursor up"},
				{"↓", "Move cursor down"},
				{"n", "Create new worktree (with AI)"},
				{"a", "Create new worktree (from existing branch)"},
				{"enter", "Open CLI (Claude for now)"},
				{"t", "Open terminal"},
				{"o", "Open default editor"},
				{"d", "Delete selected worktree"},
			},
		},
		{
			name: "Git Operations",
			keybindings: []struct {
				key         string
				description string
			}{
				{"c", "Commit all uncommitted changes (with AI)"},
				{"p", "Push to remote (with AI)"},
				{"u", "Update from base branch (pull/merge)"},
				{"r", "Refresh status (fetch from remote, no merging)"},
				{"b", "Change base branch for new worktrees"},
				{"B", "Rename current branch"},
				{"K", "Checkout/switch branch in main repo"},
			},
		},
		{
			name: "Pull Requests",
			keybindings: []struct {
				key         string
				description string
			}{
				{"P", "Select PR and create worktree from it"},
				{"v", "Open PR in default browser"},
			},
		},
		{
			name: "Automation & Scripts",
			keybindings: []struct {
				key         string
				description string
			}{
				{"R", "Execute 'run' script (gcool.json)"},
				{";", "View and run custom scripts (gcool.json)"},
			},
		},
		{
			name: "Application",
			keybindings: []struct {
				key         string
				description string
			}{
				{"s", "Open settings"},
				{"e", "Select default editor"},
				{"S", "View tmux sessions"},
				{"g", "Generate branch name (with AI) — in new worktree modal"},
				{"h", "Show this help"},
				{"q", "Quit application"},
			},
		},
	}

	// Split categories into two groups: left (3) and right (2)
	leftCategories := categories[:3]
	rightCategories := categories[3:]

	// Calculate column width (account for padding and spacing)
	colWidth := 48
	if m.width > 120 {
		colWidth = (m.width - 16) / 2
	}

	// Render left column
	var leftCol strings.Builder
	for i, category := range leftCategories {
		leftCol.WriteString(detailKeyStyle.Render(category.name))
		leftCol.WriteString("\n")

		for _, kb := range category.keybindings {
			// Format: "  key - description"
			leftCol.WriteString(normalItemStyle.Render(fmt.Sprintf("  %-10s %s", kb.key, "—")))
			leftCol.WriteString(" ")
			leftCol.WriteString(helpStyle.Render(kb.description))
			leftCol.WriteString("\n")
		}

		// Add spacing between categories
		if i < len(leftCategories)-1 {
			leftCol.WriteString("\n")
		}
	}

	// Render right column
	var rightCol strings.Builder
	for i, category := range rightCategories {
		rightCol.WriteString(detailKeyStyle.Render(category.name))
		rightCol.WriteString("\n")

		for _, kb := range category.keybindings {
			// Format: "  key - description"
			rightCol.WriteString(normalItemStyle.Render(fmt.Sprintf("  %-10s %s", kb.key, "—")))
			rightCol.WriteString(" ")
			rightCol.WriteString(helpStyle.Render(kb.description))
			rightCol.WriteString("\n")
		}

		// Add spacing between categories
		if i < len(rightCategories)-1 {
			rightCol.WriteString("\n")
		}
	}

	// Add hint about AI capabilities
	rightCol.WriteString("\n")
	rightCol.WriteString(helpStyle.Render("(with AI) = AI automations if enabled"))

	// Join columns horizontally with proper spacing
	colStyle := lipgloss.NewStyle().Width(colWidth)
	leftRendered := colStyle.Render(leftCol.String())
	rightRendered := colStyle.Render(rightCol.String())
	columnsContent := lipgloss.JoinHorizontal(lipgloss.Top, leftRendered, rightRendered)

	// Combine with title and footer
	var finalContent strings.Builder
	finalContent.WriteString(modalTitleStyle.Render("📖 Help - Keybindings"))
	finalContent.WriteString("\n\n")
	finalContent.WriteString(columnsContent)
	finalContent.WriteString("\n\n")
	finalContent.WriteString(helpStyle.Render("Press 'h' or Esc to close this help"))

	// Create modal with appropriate width
	maxWidth := m.width - 4
	if maxWidth > 160 {
		maxWidth = 160
	}
	content := modalStyle.Width(maxWidth).Render(finalContent.String())

	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		content,
	)
}

// renderScriptsModal renders the scripts selection modal with running and available scripts
func (m Model) renderScriptsModal() string {
	var b strings.Builder

	if len(m.runningScripts) == 0 && !m.scriptConfig.HasScripts() {
		b.WriteString(modalTitleStyle.Render("Scripts"))
		b.WriteString("\n\n")
		b.WriteString(normalItemStyle.Render("No scripts configured in gcool.json"))
		b.WriteString("\n\n")
		b.WriteString(helpStyle.Render("Press Esc to close"))
	} else {
		b.WriteString(modalTitleStyle.Render("Scripts"))
		b.WriteString("\n\n")

		// Show running scripts section
		if len(m.runningScripts) > 0 {
			b.WriteString(detailKeyStyle.Render("Running Scripts:"))
			b.WriteString("\n")

			for i, script := range m.runningScripts {
				var style lipgloss.Style
				if m.isViewingRunning && i == m.selectedScriptIdx {
					style = selectedItemStyle
				} else {
					style = normalItemStyle
				}

				statusIcon := "⏳"
				displayText := fmt.Sprintf("  %s %s", statusIcon, script.name)
				if script.finished {
					statusIcon = "✓"
					displayText = fmt.Sprintf("  %s %s", statusIcon, script.name)
				} else {
					elapsed := time.Since(script.startTime).Seconds()
					displayText = fmt.Sprintf("  %s %s (%0.0fs)", statusIcon, script.name, elapsed)
				}
				b.WriteString(style.Render(displayText))
				b.WriteString("\n")
			}
			b.WriteString("\n")
		}

		// Show automatic scripts section (view-only)
		if onWorktreeCreate := m.scriptConfig.GetScript("onWorktreeCreate"); onWorktreeCreate != "" {
			b.WriteString(detailKeyStyle.Render("Automatic Scripts (view-only):"))
			b.WriteString("\n")
			displayText := fmt.Sprintf("  ⚙ onWorktreeCreate")
			dimmedStyle := normalItemStyle.Copy().Foreground(mutedColor)
			b.WriteString(dimmedStyle.Render(displayText))
			b.WriteString("\n")
			b.WriteString(detailKeyStyle.Render("  Command: "))
			b.WriteString(detailValueStyle.Render(onWorktreeCreate))
			b.WriteString("\n\n")
		}

		// Show available scripts section
		if len(m.scriptNames) > 0 {
			b.WriteString(detailKeyStyle.Render("Available Scripts:"))
			b.WriteString("\n")

			maxVisible := 5
			start := m.selectedScriptIdx - maxVisible/2
			if start < 0 {
				start = 0
			}
			end := start + maxVisible
			if end > len(m.scriptNames) {
				end = len(m.scriptNames)
				start = end - maxVisible
				if start < 0 {
					start = 0
				}
			}

			for i := start; i < end; i++ {
				scriptName := m.scriptNames[i]
				var style lipgloss.Style
				if !m.isViewingRunning && i == m.selectedScriptIdx {
					style = selectedItemStyle
				} else {
					style = normalItemStyle
				}

				displayText := fmt.Sprintf("  • %s", scriptName)
				b.WriteString(style.Render(displayText))
				b.WriteString("\n")
			}

			// Show selected script command for preview
			if len(m.scriptNames) > 0 && m.selectedScriptIdx < len(m.scriptNames) {
				selectedScript := m.scriptNames[m.selectedScriptIdx]
				cmd := m.scriptConfig.GetScript(selectedScript)
				b.WriteString("\n")
				b.WriteString(detailKeyStyle.Render("Command: "))
				b.WriteString(detailValueStyle.Render(cmd))
				b.WriteString("\n")
			}
		}

		b.WriteString("\n")
		helpText := "↑/↓ select • Enter open/run • Esc cancel"
		if len(m.runningScripts) > 0 {
			helpText += " • d kill"
		}
		b.WriteString(helpStyle.Render(helpText))
	}

	// Center the modal
	content := modalStyle.Width(m.width - 4).Render(b.String())
	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		content,
	)
}

// renderScriptOutputModal renders the script output modal
func (m Model) renderScriptOutputModal() string {
	var b strings.Builder

	// Get current script execution
	if m.viewingScriptIdx < 0 || m.viewingScriptIdx >= len(m.runningScripts) {
		b.WriteString(modalTitleStyle.Render("Script Output"))
		b.WriteString("\n\n")
		b.WriteString(normalItemStyle.Render("No script selected"))
		b.WriteString("\n\n")
		b.WriteString(helpStyle.Render("Press Esc to close"))
	} else {
		script := m.runningScripts[m.viewingScriptIdx]

		// Title with script name
		title := fmt.Sprintf("Script Output: %s", script.name)
		b.WriteString(modalTitleStyle.Render(title))
		b.WriteString("\n\n")

		// Show running/finished status with elapsed time
		elapsed := time.Since(script.startTime).Seconds()
		if !script.finished {
			b.WriteString(normalItemStyle.Copy().Foreground(mutedColor).Render(fmt.Sprintf("Running... (%0.0fs)", elapsed)))
		} else {
			b.WriteString(normalItemStyle.Copy().Foreground(successColor).Render(fmt.Sprintf("✓ Finished (%0.0fs)", elapsed)))
		}
		b.WriteString("\n\n")

		// Show script output in a box
		maxWidth := m.width - 20
		maxHeight := m.height - 10

		// Render output with line wrapping
		output := script.output
		if output == "" {
			output = "(no output)"
		}

		// Create scrollable output display
		lines := strings.Split(output, "\n")
		visibleLines := lines
		if len(lines) > maxHeight {
			// Show last N lines if output is too long
			visibleLines = lines[len(lines)-maxHeight:]
			b.WriteString(normalItemStyle.Copy().Foreground(mutedColor).Render("... (scrolled to end)"))
			b.WriteString("\n")
		}

		outputText := strings.Join(visibleLines, "\n")
		outputBox := panelStyle.Width(maxWidth).Height(maxHeight).Render(outputText)
		b.WriteString(outputBox)

		b.WriteString("\n\n")
		// Show keybindings
		if script.finished {
			b.WriteString(helpStyle.Render("Esc back to scripts"))
		} else {
			b.WriteString(helpStyle.Render("k kill • Esc back to scripts"))
		}
	}

	// Center the modal
	content := modalStyle.Width(m.width - 4).Render(b.String())
	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		content,
	)
}


func (m Model) renderMergeStrategyModal() string {
	var b strings.Builder

	b.WriteString(modalTitleStyle.Render("Select Merge Strategy"))
	b.WriteString("\n\n")

	// Merge strategy options with descriptions
	strategies := []struct {
		name        string
		description string
	}{
		{"Squash and merge", "All commits squashed into one commit on the base branch"},
		{"Create a merge commit", "Preserves all commits from the PR in the history with a merge commit"},
		{"Rebase and merge", "Replays commits from PR onto base branch without a merge commit"},
	}

	for i, strategy := range strategies {
		isSelected := i == m.mergeStrategyCursor

		var strategyText string
		if isSelected {
			strategyText = selectedItemStyle.Render("▶ " + strategy.name)
		} else {
			strategyText = normalItemStyle.Render("  " + strategy.name)
		}

		b.WriteString(strategyText)
		b.WriteString("\n")

		// Add description
		descStyle := normalItemStyle.Copy().Foreground(mutedColor)
		b.WriteString(descStyle.Render("  " + strategy.description))
		b.WriteString("\n\n")
	}

	// Help text
	b.WriteString(helpStyle.Render("↑/↓ select • enter confirm • esc cancel"))

	// Center the modal
	content := modalStyle.Width(m.width - 4).Render(b.String())
	return lipgloss.Place(
		m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		content,
	)
}
