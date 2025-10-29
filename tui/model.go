package tui

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/coollabsio/gcool/config"
	"github.com/coollabsio/gcool/git"
	"github.com/coollabsio/gcool/github"
	"github.com/coollabsio/gcool/session"
)

// SwitchInfo contains information about the worktree to switch to
type SwitchInfo struct {
	Path           string
	Branch         string
	AutoClaude     bool
	TerminalOnly   bool // If true, open terminal session instead of Claude session
}

type modalType int

const (
	noModal modalType = iota
	createModal
	deleteModal
	branchSelectModal
	checkoutBranchModal
	sessionListModal
	renameModal
	changeBaseBranchModal
	editorSelectModal
	settingsModal
	tmuxConfigModal
	commitModal
	helperModal
)

// Model represents the TUI state
type Model struct {
	gitManager     *git.Manager
	sessionManager *session.Manager
	configManager  *config.Manager
	githubManager  *github.Manager
	worktrees      []git.Worktree
	branches       []string
	sessions       []session.Session
	repoPath       string // Path to the repository

	// UI state
	selectedIndex   int
	sessionIndex    int
	width           int
	height          int
	ready           bool
	err             error
	status          string
	switchInfo      SwitchInfo // Info about worktree to switch to
	autoClaude      bool       // Whether to auto-start Claude
	baseBranch      string     // Base branch for new worktrees

	// Branch status tracking
	lastCreatedBranch string // Last created branch name (for auto-selection after creation)

	// Activity tracking
	lastActivityCheck     time.Time
	activityCheckInterval time.Duration

	// Modal state
	modal                  modalType
	modalFocused           int // Which input/button is focused in modal
	nameInput              textinput.Model
	pathInput              textinput.Model
	searchInput            textinput.Model
	commitSubjectInput     textinput.Model // Subject line for commit message
	commitBodyInput        textinput.Model // Body for commit message
	branchIndex            int
	filteredBranches       []string // Filtered list of branches for search
	createNewBranch        bool
	editorIndex            int      // Selected editor index
	editors                []string // List of available editors
	settingsIndex          int      // Selected setting option index
	deleteHasUncommitted   bool     // Whether worktree to delete has uncommitted changes
	deleteConfirmForce     bool     // User acknowledged they want to delete despite uncommitted changes
}

// NewModel creates a new TUI model
func NewModel(repoPath string, autoClaude bool) Model {
	nameInput := textinput.New()
	nameInput.Placeholder = "branch-name"
	nameInput.Focus()
	nameInput.CharLimit = 156
	nameInput.Width = 50

	pathInput := textinput.New()
	pathInput.Placeholder = "/path/to/worktree"
	pathInput.CharLimit = 256
	pathInput.Width = 50

	searchInput := textinput.New()
	searchInput.Placeholder = "Search branches..."
	searchInput.CharLimit = 100
	searchInput.Width = 50

	commitSubjectInput := textinput.New()
	commitSubjectInput.Placeholder = "Commit subject (required)"
	commitSubjectInput.CharLimit = 72
	commitSubjectInput.Width = 70

	commitBodyInput := textinput.New()
	commitBodyInput.Placeholder = "Commit body (optional)"
	commitBodyInput.CharLimit = 500
	commitBodyInput.Width = 70

	// Initialize config manager (ignore errors, will use defaults)
	configManager, _ := config.NewManager()

	// Create git manager and get absolute repo root path
	gitManager := git.NewManager(repoPath)
	absoluteRepoPath := repoPath
	if root, err := gitManager.GetRepoRoot(); err == nil {
		absoluteRepoPath = root
	}

	// List of common editors
	editors := []string{
		"code",    // VS Code
		"cursor",  // Cursor
		"nvim",    // Neovim
		"vim",     // Vim
		"subl",    // Sublime Text
		"atom",    // Atom
		"zed",     // Zed
	}

	return Model{
		gitManager:         gitManager,
		sessionManager:     session.NewManager(),
		configManager:      configManager,
		githubManager:      github.NewManager(),
		nameInput:          nameInput,
		pathInput:          pathInput,
		searchInput:        searchInput,
		commitSubjectInput: commitSubjectInput,
		commitBodyInput:    commitBodyInput,
		autoClaude:         autoClaude,
		repoPath:           absoluteRepoPath,
		editors:            editors,
	}
}

// Init initializes the model
func (m Model) Init() tea.Cmd {
	m.activityCheckInterval = 1 * time.Second
	m.lastActivityCheck = time.Now()
	return tea.Batch(
		m.loadWorktrees,
		m.loadBaseBranch,
		m.scheduleActivityCheck(),
		tea.EnterAltScreen,
	)
}

// Messages
type (
	worktreesLoadedMsg struct {
		worktrees []git.Worktree
		err       error
	}

	branchesLoadedMsg struct {
		branches []string
		err      error
	}

	worktreeCreatedMsg struct {
		err    error
		path   string
		branch string
	}

	worktreeDeletedMsg struct {
		err error
	}

	branchRenamedMsg struct {
		oldBranch string
		newBranch string
		err       error
	}

	branchCheckedOutMsg struct {
		err error
	}

	baseBranchLoadedMsg struct {
		branch string
	}

	clearErrorMsg struct{}

	statusMsg string

	editorOpenedMsg struct {
		err error
	}

	prCreatedMsg struct {
		err   error
		prURL string
	}

	branchPulledMsg struct {
		err         error
		hadConflict bool
	}

	refreshWithPullMsg struct {
		err               error
		fetchedCommits    int             // Total commits fetched from remote
		updatedBranches   map[string]int  // Branch name -> commits pulled
		upToDate          bool            // Whether everything was already up to date
		mergedBaseBranch  bool            // Whether base branch was merged into selected worktree
	}

	activityTickMsg time.Time

	activityCheckedMsg struct {
		sessions []session.Session
		err      error
	}

	commitCreatedMsg struct {
		err        error
		commitHash string
	}
)

// Commands
func (m Model) loadWorktrees() tea.Msg {
	worktrees, err := m.gitManager.List()
	return worktreesLoadedMsg{worktrees: worktrees, err: err}
}

func (m Model) loadBranches() tea.Msg {
	branches, err := m.gitManager.ListBranches()
	return branchesLoadedMsg{branches: branches, err: err}
}

func (m Model) createWorktree(path, branch string, newBranch bool) tea.Cmd {
	return func() tea.Msg {
		// Ensure .workspaces directory exists
		if err := m.gitManager.EnsureWorkspacesDir(); err != nil {
			return worktreeCreatedMsg{err: err, path: path, branch: branch}
		}

		// Use base branch when creating new branch
		baseBranch := ""
		if newBranch {
			baseBranch = m.baseBranch
		}

		err := m.gitManager.Create(path, branch, newBranch, baseBranch)
		return worktreeCreatedMsg{err: err, path: path, branch: branch}
	}
}

func (m Model) deleteWorktree(path, branch string, force bool) tea.Cmd {
	return func() tea.Msg {
		// First remove the worktree
		err := m.gitManager.Remove(path, force)
		if err != nil {
			return worktreeDeletedMsg{err: err}
		}

		// Then kill the associated tmux sessions if they exist
		// Kill Claude session
		sessionName := m.sessionManager.SanitizeName(branch)
		_ = m.sessionManager.Kill(sessionName) // Ignore error if session doesn't exist

		// Kill terminal-only session (if it exists)
		terminalSessionName := m.sessionManager.SanitizeNameTerminal(branch)
		_ = m.sessionManager.Kill(terminalSessionName) // Ignore error if session doesn't exist

		return worktreeDeletedMsg{err: nil}
	}
}

func (m Model) renameBranch(oldName, newName string) tea.Cmd {
	return func() tea.Msg {
		err := m.gitManager.RenameBranch(oldName, newName)
		return branchRenamedMsg{oldBranch: oldName, newBranch: newName, err: err}
	}
}

func (m Model) renameSessionsForBranch(oldBranch, newBranch string) tea.Cmd {
	return func() tea.Msg {
		// Sanitize both branch names for session names
		oldSessionName := m.sessionManager.SanitizeName(oldBranch)
		newSessionName := m.sessionManager.SanitizeName(newBranch)
		oldTerminalSessionName := m.sessionManager.SanitizeNameTerminal(oldBranch)
		newTerminalSessionName := m.sessionManager.SanitizeNameTerminal(newBranch)

		// Rename Claude session
		if err := m.sessionManager.RenameSession(oldSessionName, newSessionName); err != nil {
			// Log error but continue (session might not exist)
		}

		// Rename terminal session
		if err := m.sessionManager.RenameSession(oldTerminalSessionName, newTerminalSessionName); err != nil {
			// Log error but continue (session might not exist)
		}

		return nil
	}
}

func (m Model) checkoutBranch(branch string) tea.Cmd {
	return func() tea.Msg {
		err := m.gitManager.CheckoutBranch(branch)
		return branchCheckedOutMsg{err: err}
	}
}

func (m Model) loadBaseBranch() tea.Msg {
	// First, try to load from config
	if m.configManager != nil {
		if savedBranch := m.configManager.GetBaseBranch(m.repoPath); savedBranch != "" {
			return baseBranchLoadedMsg{branch: savedBranch}
		}
	}

	// If not in config, try current branch
	branch, err := m.gitManager.GetCurrentBranch()
	if err != nil || branch == "" {
		// Try to get default branch (main or master)
		defaultBranch, err := m.gitManager.GetDefaultBranch()
		if err != nil {
			// Last resort: empty (user must set manually)
			return baseBranchLoadedMsg{branch: ""}
		}
		return baseBranchLoadedMsg{branch: defaultBranch}
	}
	return baseBranchLoadedMsg{branch: branch}
}

func (m Model) openInEditor(path string) tea.Cmd {
	return func() tea.Msg {
		// Get configured editor (defaults to "code")
		editor := "code"
		if m.configManager != nil {
			editor = m.configManager.GetEditor(m.repoPath)
		}

		// Open editor in background
		cmd := exec.Command(editor, path)
		err := cmd.Start()
		if err != nil {
			return editorOpenedMsg{err: fmt.Errorf("failed to open %s: %w. Press 'e' to select a different editor", editor, err)}
		}
		return editorOpenedMsg{err: nil}
	}
}

func (m Model) createPR(worktreePath, branch string) tea.Cmd {
	return func() tea.Msg {
		// Check if it's a GitHub repo
		isGitHub, err := m.gitManager.IsGitHubRepo()
		if err != nil {
			return prCreatedMsg{err: fmt.Errorf("failed to check repository: %w", err)}
		}
		if !isGitHub {
			return prCreatedMsg{err: fmt.Errorf("not a GitHub repository")}
		}

		// Check if base branch is set
		if m.baseBranch == "" {
			return prCreatedMsg{err: fmt.Errorf("base branch not set. Press 'c' to set base branch")}
		}

		// Check if the branch has any commits
		hasCommits, err := m.gitManager.HasCommits(worktreePath)
		if err != nil {
			return prCreatedMsg{err: fmt.Errorf("failed to check for commits: %w", err)}
		}
		if !hasCommits {
			return prCreatedMsg{err: fmt.Errorf("no commits to create PR")}
		}

		// Check if remote branch exists
		remoteBranchExists, err := m.gitManager.RemoteBranchExists(worktreePath, branch)
		if err != nil {
			return prCreatedMsg{err: fmt.Errorf("failed to check remote branch: %w", err)}
		}

		// Only push if branch doesn't exist remotely or has unpushed commits
		if !remoteBranchExists {
			// Push the branch for the first time
			if err := m.gitManager.Push(worktreePath, branch); err != nil {
				return prCreatedMsg{err: fmt.Errorf("failed to push commits: %w", err)}
			}
		} else {
			// Branch exists remotely, check if we have unpushed commits
			hasUnpushed, err := m.gitManager.HasUnpushedCommits(worktreePath, branch)
			if err != nil {
				return prCreatedMsg{err: fmt.Errorf("failed to check for unpushed commits: %w", err)}
			}
			if hasUnpushed {
				// Push new commits
				if err := m.gitManager.Push(worktreePath, branch); err != nil {
					return prCreatedMsg{err: fmt.Errorf("failed to push commits: %w", err)}
				}
			}
			// If no unpushed commits, branch is already up to date, continue to PR creation
		}

		// Create PR title from branch name (replace hyphens/underscores with spaces and capitalize)
		title := strings.ReplaceAll(branch, "-", " ")
		title = strings.ReplaceAll(title, "_", " ")
		title = strings.Title(title)

		// Create draft PR
		prURL, err := m.githubManager.CreateDraftPR(worktreePath, branch, m.baseBranch, title)
		if err != nil {
			return prCreatedMsg{err: err}
		}

		return prCreatedMsg{prURL: prURL}
	}
}

// createCommit creates a commit with the given subject and body
func (m Model) createCommit(worktreePath, subject, body string) tea.Cmd {
	return func() tea.Msg {
		if subject == "" {
			return commitCreatedMsg{err: fmt.Errorf("commit subject cannot be empty")}
		}

		commitHash, err := m.gitManager.CreateCommit(worktreePath, subject, body)
		return commitCreatedMsg{err: err, commitHash: commitHash}
	}
}

// Helper methods
func (m Model) selectedWorktree() *git.Worktree {
	if m.selectedIndex < 0 || m.selectedIndex >= len(m.worktrees) {
		return nil
	}
	return &m.worktrees[m.selectedIndex]
}

func (m Model) selectedBranch() string {
	// Use filtered branches if search is active
	branches := m.branches
	if len(m.filteredBranches) > 0 || m.searchInput.Value() != "" {
		branches = m.filteredBranches
	}

	if m.branchIndex < 0 || m.branchIndex >= len(branches) {
		return ""
	}
	return branches[m.branchIndex]
}

func (m Model) filterBranches(query string) []string {
	if query == "" {
		return m.branches
	}

	var filtered []string
	queryLower := strings.ToLower(query)
	for _, branch := range m.branches {
		if strings.Contains(strings.ToLower(branch), queryLower) {
			filtered = append(filtered, branch)
		}
	}
	return filtered
}

// GetSwitchInfo returns the switch information (for shell integration)
func (m Model) GetSwitchInfo() SwitchInfo {
	return m.switchInfo
}

// loadSessions loads tmux sessions
func (m Model) loadSessions() tea.Msg {
	sessions, err := m.sessionManager.List()
	if err != nil {
		return statusMsg("Failed to load sessions")
	}
	return sessionsLoadedMsg{sessions: sessions}
}

type sessionsLoadedMsg struct {
	sessions []session.Session
}

// pullFromBaseBranch pulls changes from the base branch into the worktree
func (m Model) pullFromBaseBranch(worktreePath, baseBranch string) tea.Cmd {
	return func() tea.Msg {
		// Fetch first to ensure we have latest changes
		if err := m.gitManager.FetchRemote(); err != nil {
			return branchPulledMsg{err: fmt.Errorf("failed to fetch: %w", err)}
		}

		// Merge base branch into current branch
		err := m.gitManager.MergeBranch(worktreePath, baseBranch)
		if err != nil {
			// Check if it's a merge conflict
			if strings.Contains(err.Error(), "merge conflict") {
				return branchPulledMsg{err: err, hadConflict: true}
			}
			return branchPulledMsg{err: err, hadConflict: false}
		}

		return branchPulledMsg{err: nil, hadConflict: false}
	}
}

// refreshWithPull orchestrates pulling latest commits and refreshing worktrees
// 1. Pulls base branch in main repository
// 2. Pulls base branch in selected worktree
// 3. Pulls selected worktree's current branch from origin
// 4. Refreshes worktree list
func (m Model) refreshWithPull() tea.Cmd {
	return func() tea.Msg {
		msg := refreshWithPullMsg{
			updatedBranches: make(map[string]int),
			upToDate:        true, // Assume up to date unless we pull something
		}

		// Fetch all updates from remote first
		if err := m.gitManager.FetchRemote(); err != nil {
			return refreshWithPullMsg{err: fmt.Errorf("failed to fetch updates: %w", err)}
		}

		wt := m.selectedWorktree()
		if wt == nil {
			return refreshWithPullMsg{err: fmt.Errorf("no worktree selected")}
		}

		// Step 1: Pull base branch in main repository
		if m.baseBranch != "" {
			output, err := m.gitManager.PullBranchInPathWithOutput(m.repoPath, m.baseBranch)
			if err != nil {
				// Check if it's a conflict - if so, abort and return error
				if strings.Contains(err.Error(), "merge conflict") {
					_ = m.gitManager.AbortMerge(m.repoPath)
					return refreshWithPullMsg{err: fmt.Errorf("merge conflict in main repo while pulling base branch. Merge aborted")}
				}
				// For non-conflict errors, continue with next step
			} else {
				// Parse output to track commits
				upToDate, commits := m.gitManager.ParsePullOutput(output)
				if !upToDate && commits > 0 {
					msg.upToDate = false
					msg.updatedBranches[m.baseBranch] += commits
				}
			}
		}

		// Step 2: Pull base branch in selected worktree
		if m.baseBranch != "" && wt.Branch != m.baseBranch {
			output, err := m.gitManager.PullBranchInPathWithOutput(wt.Path, m.baseBranch)
			if err != nil {
				// Check if it's a conflict - if so, abort and return error
				if strings.Contains(err.Error(), "merge conflict") {
					_ = m.gitManager.AbortMerge(wt.Path)
					return refreshWithPullMsg{err: fmt.Errorf("merge conflict in worktree while pulling base branch. Merge aborted")}
				}
				// For non-conflict errors, continue with next step
			} else {
				// Parse output to track commits
				upToDate, commits := m.gitManager.ParsePullOutput(output)
				if !upToDate && commits > 0 {
					msg.upToDate = false
					msg.mergedBaseBranch = true
					// Don't add to updatedBranches for base branch merge, it's tracked separately
				}
			}
		}

		// Step 3: Pull selected worktree's current branch from origin
		if wt.Branch != "" {
			output, err := m.gitManager.PullCurrentBranchWithOutput(wt.Path, wt.Branch)
			if err != nil {
				// Check if it's a conflict - if so, abort and return error
				if strings.Contains(err.Error(), "merge conflict") {
					_ = m.gitManager.AbortMerge(wt.Path)
					return refreshWithPullMsg{err: fmt.Errorf("merge conflict while pulling branch '%s'. Merge aborted", wt.Branch)}
				}
				// For non-conflict errors, still continue to refresh
			} else {
				// Parse output to track commits
				upToDate, commits := m.gitManager.ParsePullOutput(output)
				if !upToDate && commits > 0 {
					msg.upToDate = false
					msg.updatedBranches[wt.Branch] += commits
				}
			}
		}

		// Step 4: Worktree list will be reloaded by the Update handler
		// Return success so the handler can reload the list
		return msg
	}
}

// scheduleActivityCheck schedules periodic activity checks
func (m Model) scheduleActivityCheck() tea.Cmd {
	return tea.Every(2*time.Second, func(t time.Time) tea.Msg {
		return activityTickMsg(t)
	})
}

// checkSessionActivity checks for recent session activity
func (m Model) checkSessionActivity() tea.Cmd {
	return func() tea.Msg {
		sessions, err := m.sessionManager.List()
		if err != nil {
			return activityCheckedMsg{sessions: []session.Session{}, err: err}
		}
		return activityCheckedMsg{sessions: sessions, err: nil}
	}
}
