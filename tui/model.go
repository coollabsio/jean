package tui

import (
	"bufio"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/coollabsio/gcool/config"
	"github.com/coollabsio/gcool/git"
	"github.com/coollabsio/gcool/github"
	"github.com/coollabsio/gcool/openrouter"
	"github.com/coollabsio/gcool/session"
)

// Package-level shared state for streaming script output
var (
	scriptOutputBuffers = make(map[int]*scriptOutputBuffer)
	scriptBuffersMutex  sync.RWMutex
)

type scriptOutputBuffer struct {
	buffer   strings.Builder
	mutex    sync.Mutex
	finished bool
	cmd      *exec.Cmd
}

// SwitchInfo contains information about the worktree to switch to
type SwitchInfo struct {
	Path                 string
	Branch               string
	AutoClaude           bool
	TargetWindow         string // Which window to attach to: "terminal" or "claude"
	ScriptCommand        string // If set, run this script command instead of shell/Claude
	SessionName          string // Custom name for Claude session (for --session flag)
	IsClaudeInitialized  bool   // Whether this Claude session has been initialized before
}

// ScriptExecution represents a running or completed script
type ScriptExecution struct {
	name         string    // Name of the script from gcool.json
	command      string    // The actual command to run
	output       string    // Captured output
	pid          int       // Process ID (for killing)
	finished     bool      // Whether execution has completed
	startTime    time.Time // When the script started
	worktreePath string    // Path to the worktree where this script is running
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
	themeSelectModal
	aiSettingsModal
	prContentModal
	prListModal
	scriptsModal
	scriptOutputModal
	createWithNameModal
	mergeStrategyModal
)

// NotificationType defines the type of notification
type NotificationType int

const (
	NotificationSuccess NotificationType = iota
	NotificationError
	NotificationWarning
	NotificationInfo
)

// Notification represents a notification message to display
type Notification struct {
	ID       int64             // Unique ID to identify this notification
	Message  string
	Type     NotificationType
	Duration time.Duration     // How long to display before auto-dismiss (0 = no auto-dismiss)
	Timestamp time.Time
}

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

	// Notification system
	notification         *Notification    // Current displayed notification
	notificationVisible  bool
	notificationStarted  time.Time
	notificationID       int64             // Counter for unique notification IDs

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
	sessionNameInput       textinput.Model // Session name input for new worktree
	commitSubjectInput     textinput.Model // Subject line for commit message
	commitBodyInput        textinput.Model // Body for commit message
	prTitleInput           textinput.Model // PR title input
	prDescriptionInput     textinput.Model // PR description input
	prModalFocused         int             // Which field in PR modal is focused (0=title, 1=description, 2=create, 3=cancel)
	prModalWorktreePath    string          // Worktree path for PR being created
	prModalBranch          string          // Branch for PR being created
	branchIndex            int
	filteredBranches       []string // Filtered list of branches for search
	createNewBranch        bool
	editorIndex            int      // Selected editor index
	editors                []string // List of available editors
	themeIndex             int      // Selected theme index
	availableThemes        []ThemeInfo   // List of available themes
	originalTheme          string        // Original theme before entering theme selection modal (for preview revert)
	settingsIndex          int           // Selected setting option index
	deleteHasUncommitted   bool     // Whether worktree to delete has uncommitted changes
	deleteConfirmForce     bool     // User acknowledged they want to delete despite uncommitted changes

	// AI Settings modal state
	aiSettingsIndex        int                    // Selected AI setting option index
	aiAPIKeyInput          textinput.Model        // Input field for OpenRouter API key
	aiModelIndex           int                    // Selected model index
	aiModels               []string               // List of available OpenRouter models
	aiCommitEnabled        bool                   // Whether AI commit message generation is enabled
	aiBranchNameEnabled    bool                   // Whether AI branch name generation is enabled
	aiModalFocusedField    int                    // Which field in AI settings modal is focused (0-4: api key, model, commit toggle, branch toggle, buttons)
	aiModalStatus          string                 // Status message for AI settings modal (error/success)
	aiModalStatusTime      time.Time              // When the status was set

	// Commit modal status
	commitModalStatus      string                 // Status message for commit modal (error/success from AI)
	commitModalStatusTime  time.Time              // When the status was set
	generatingCommit       bool                   // Whether we're currently generating a commit message
	spinnerFrame           int                    // Current spinner animation frame (0-3)

	// Rename modal status (AI generation)
	renameModalStatus      string                 // Status message for rename modal (error/success from AI)
	renameModalStatusTime  time.Time              // When the status was set
	generatingRename       bool                   // Whether we're currently generating a rename suggestion
	renameSpinnerFrame     int                    // Current spinner animation frame for rename (0-9)

	// PR creation with AI branch naming state
	pendingPRNewName  string // New branch name being used for PR creation
	pendingPROldName  string // Old branch name being replaced
	pendingPRWorktree string // Worktree path for PR creation

	// PR content state (title and description generated by AI)
	pendingPRTitle       string // AI-generated PR title
	pendingPRDescription string // AI-generated PR description

	// PR commit flow state
	commitBeforePR      bool   // Flag to track if we're committing before PR creation
	prCreationPending   string // Worktree path for PR creation after commit

	// Auto-commit with AI state
	autoCommitWithAI    bool   // Flag to track if we're auto-committing with AI (without opening modal)

	// PR content modal AI generation state
	generatingPRContent bool // Whether we're currently generating PR content
	prSpinnerFrame      int  // Current spinner animation frame for PR modal (0-9)

	// PR list modal state
	prListIndex int // Selected PR index in the PR list modal
	prListMergeMode bool // Whether PR list modal is in merge mode (user pressed SHIFT+M)

	// Merge strategy modal state
	mergeStrategyCursor int // Selected merge strategy (0=squash, 1=merge, 2=rebase)
	selectedPRForMerge string // PR URL to merge
	prs            []github.PRInfo      // All PRs from GitHub
	filteredPRs    []github.PRInfo      // Filtered PRs based on search
	prSearchInput  textinput.Model      // Search input for PR filtering
	prLoadingError string               // Error message when loading PRs

	// Scripts modal state
	scriptConfig       *config.ScriptConfig   // Loaded script configuration
	scriptNames        []string               // List of available script names
	runningScripts     []ScriptExecution      // List of running/completed scripts
	selectedScriptIdx  int                    // Selected script index (in scripts modal)
	isViewingRunning   bool                   // Whether selected script is running (vs available)
	viewingScriptName  string                 // Name of currently viewed script in output modal
	viewingScriptIdx   int                    // Index in runningScripts of currently viewed script

	// PR retry state (when PR already exists)
	prRetryWorktreePath string // Worktree path for PR retry attempt
	prRetryBranch       string // Branch name for PR retry attempt
	prRetryTitle        string // Generated title for PR retry
	prRetryDescription  string // Generated description for PR retry
	prRetryInProgress   bool   // Whether we're already in a retry attempt (prevent infinite loops)

	// Worktree switch state (for ensuring worktree exists before switching)
	pendingSwitchInfo   *SwitchInfo // Info for pending switch (will be completed after ensure succeeds)
	ensuringWorktree    bool        // Whether we're currently ensuring a worktree exists

	// Claude status detection
	claudeStatuses    map[string]session.ClaudeStatus   // Status per session name
	claudeStatusFrame int                               // Current animation frame for spinner
	statusDetectors   map[string]*session.StatusDetector // Status detectors per session

	// Initialization state
	isInitializing bool // Suppress notifications during app startup (before first successful worktree load)
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

	sessionNameInput := textinput.New()
	sessionNameInput.Placeholder = "Session name (e.g., my-feature)"
	sessionNameInput.CharLimit = 100
	sessionNameInput.Width = 50

	commitSubjectInput := textinput.New()
	commitSubjectInput.Placeholder = "Commit subject (required)"
	commitSubjectInput.CharLimit = 72
	commitSubjectInput.Width = 70

	commitBodyInput := textinput.New()
	commitBodyInput.Placeholder = "Commit body (optional)"
	commitBodyInput.CharLimit = 500
	commitBodyInput.Width = 70

	prTitleInput := textinput.New()
	prTitleInput.Placeholder = "PR title (required, max 72 characters)"
	prTitleInput.CharLimit = 72
	prTitleInput.Width = 70

	prDescriptionInput := textinput.New()
	prDescriptionInput.Placeholder = "PR description (optional, explain what and why)"
	prDescriptionInput.CharLimit = 500
	prDescriptionInput.Width = 70

	aiAPIKeyInput := textinput.New()
	aiAPIKeyInput.Placeholder = "sk-or-..."
	aiAPIKeyInput.CharLimit = 256
	aiAPIKeyInput.Width = 50
	aiAPIKeyInput.EchoMode = textinput.EchoPassword // Mask API key input

	prSearchInput := textinput.New()
	prSearchInput.Placeholder = "Search PRs by title, author, or branch..."
	prSearchInput.CharLimit = 100
	prSearchInput.Width = 50

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

	// List of OpenRouter models
	aiModels := []string{
		"google/gemini-2.5-flash-lite",
		"google/gemini-2.0-flash",
		"google/gemini-2.0-flash-exp",
		"google/gemini-1.5-pro",
		"google/gemini-1.5-flash",
		"anthropic/claude-3.5-haiku",
		"anthropic/claude-3.5-sonnet",
		"anthropic/claude-3-opus",
		"openai/gpt-4-turbo",
		"openai/gpt-4",
		"meta-llama/llama-2-70b-chat",
	}

	m := Model{
		gitManager:         gitManager,
		sessionManager:     session.NewManager(),
		configManager:      configManager,
		githubManager:      github.NewManager(),
		nameInput:          nameInput,
		pathInput:          pathInput,
		searchInput:        searchInput,
		sessionNameInput:   sessionNameInput,
		commitSubjectInput: commitSubjectInput,
		commitBodyInput:    commitBodyInput,
		prTitleInput:       prTitleInput,
		prDescriptionInput: prDescriptionInput,
		aiAPIKeyInput:      aiAPIKeyInput,
		prSearchInput:      prSearchInput,
		aiModels:           aiModels,
		autoClaude:         autoClaude,
		repoPath:           absoluteRepoPath,
		editors:            editors,
		availableThemes:    GetAvailableThemes(),
		claudeStatuses:   make(map[string]session.ClaudeStatus),
		statusDetectors:  make(map[string]*session.StatusDetector),
		isInitializing:   true,
	}

	// Load AI settings from config
	if configManager != nil {
		if apiKey := configManager.GetOpenRouterAPIKey(); apiKey != "" {
			m.aiAPIKeyInput.SetValue(apiKey)
		}
		m.aiCommitEnabled = configManager.GetAICommitEnabled()
		m.aiBranchNameEnabled = configManager.GetAIBranchNameEnabled()

		// Set model index based on saved model
		savedModel := configManager.GetOpenRouterModel()
		for i, model := range aiModels {
			if model == savedModel {
				m.aiModelIndex = i
				break
			}
		}
	}

	// Load scripts from gcool.json
	if scriptConfig, err := config.LoadScripts(absoluteRepoPath); err == nil {
		m.scriptConfig = scriptConfig
		allScripts := scriptConfig.GetScriptNames()

		// Filter out automatic-only scripts that should not be manually runnable
		m.scriptNames = make([]string, 0, len(allScripts))
		for _, name := range allScripts {
			// Exclude onWorktreeCreate - it's automatic-only
			if name != "onWorktreeCreate" {
				m.scriptNames = append(m.scriptNames, name)
			}
		}
	}

	return m
}

// Init initializes the model
func (m Model) Init() tea.Cmd {
	m.activityCheckInterval = 1 * time.Second
	m.lastActivityCheck = time.Now()

	// Initialize styles on startup
	InitStyles()

	// Load and apply the theme from config
	themeName := m.configManager.GetTheme(m.repoPath)
	if err := ApplyTheme(themeName); err != nil {
		// Fall back to matrix theme if the configured theme is invalid
		ApplyTheme("matrix")
	}

	return tea.Batch(
		m.loadBaseBranch(),
		m.loadSessions(),
		m.scheduleActivityCheck(),
		m.scheduleClaudeStatusCheck(),
		m.scheduleClaudeStatusAnimationTick(),
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

	prsLoadedMsg struct {
		prs []github.PRInfo
		err error
	}

	worktreeCreatedMsg struct {
		err    error
		path   string
		branch string
	}

	worktreeCreatedWithSessionMsg struct {
		err         error
		path        string
		branch      string
		sessionName string
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
		err          error
		prURL        string
		branch       string // Branch name for retry on "PR already exists"
		worktreePath string // Worktree path for retry on "PR already exists"
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
		pullErr           error           // Error from pulling the main repo branch (non-blocking)
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

	autoCommitBeforePRMsg struct {
		worktreePath string
		branch       string
		err          error
	}

	themeChangedMsg struct {
		theme string
		err   error
	}

	notificationShownMsg struct{}

	notificationHideMsg struct {
		id int64
	}

	notificationClearedMsg struct {
		id int64
	}

	commitMessageGeneratedMsg struct {
		subject string
		body    string
		err     error
	}


	apiKeyTestedMsg struct {
		success bool
		err     error
	}

	renameGeneratedMsg struct {
		name string
		err  error
	}

	renameSpinnerTickMsg struct{}

	spinnerTickMsg struct{}

	prBranchNameGeneratedMsg struct {
		oldBranchName string
		newBranchName string
		worktreePath  string
		err           error
	}

	prBranchRenamedMsg struct {
		oldBranchName   string
		newBranchName   string
		worktreePath    string
		hadRemoteBranch bool
		err             error
	}

	prRemoteBranchDeletedMsg struct {
		oldBranchName string
		newBranchName string
		worktreePath  string
		err           error
	}

	prContentGeneratedMsg struct {
		title        string
		description  string
		worktreePath string
		branch       string
		err          error
	}

	prStatusesRefreshedMsg struct {
		err error
	}

	scriptOutputMsg struct {
		scriptName string
		output     string
	}

	scriptOutputStreamMsg struct {
		scriptName string
		output     string // Incremental output chunk
		finished   bool   // True when script completes
	}

	scriptOutputPollMsg struct {
		scriptIdx int // Index of script to poll
	}

	// Push-only messages (without PR creation)
	pushBranchNameGeneratedMsg struct {
		oldBranchName string
		newBranchName string
		worktreePath  string
		err           error
	}

	pushRemoteBranchDeletedMsg struct {
		oldBranchName string
		newBranchName string
		worktreePath  string
		err           error
	}

	pushBranchRenamedMsg struct {
		oldBranchName string
		newBranchName string
		worktreePath  string
		err           error
	}

	pushCompletedMsg struct {
		branch string
		err    error
	}

	worktreeEnsuredMsg struct {
		err error
	}

	claudeStatusUpdatedMsg struct {
		sessionName string
		status      session.ClaudeStatus
	}

	claudeStatusTickMsg time.Time
)

// Commands
func (m Model) loadWorktrees() tea.Cmd {
	return func() tea.Msg {
		worktrees, err := m.gitManager.List(m.baseBranch)
		// Calculate sanitized Claude session names for each worktree
		for i := range worktrees {
			worktrees[i].ClaudeSessionName = m.sessionManager.SanitizeName(worktrees[i].Branch)
		}
		return worktreesLoadedMsg{worktrees: worktrees, err: err}
	}
}

func (m Model) loadWorktreesLightweight() tea.Cmd {
	return func() tea.Msg {
		worktrees, err := m.gitManager.ListLightweight()
		// Calculate sanitized Claude session names for each worktree
		for i := range worktrees {
			worktrees[i].ClaudeSessionName = m.sessionManager.SanitizeName(worktrees[i].Branch)
		}
		return worktreesLoadedMsg{worktrees: worktrees, err: err}
	}
}

func (m Model) loadBranches() tea.Msg {
	branches, err := m.gitManager.ListBranches()
	return branchesLoadedMsg{branches: branches, err: err}
}

func (m Model) loadPRs() tea.Cmd {
	return func() tea.Msg {
		prs, err := m.githubManager.ListPRs(m.repoPath)
		return prsLoadedMsg{prs: prs, err: err}
	}
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

func (m Model) createWorktreeWithSession(path, sessionName string, newBranch bool) tea.Cmd {
	return func() tea.Msg {
		// Ensure .workspaces directory exists
		if err := m.gitManager.EnsureWorkspacesDir(); err != nil {
			return worktreeCreatedWithSessionMsg{err: err, path: path, branch: sessionName, sessionName: sessionName}
		}

		// Use base branch when creating new branch
		baseBranch := ""
		if newBranch {
			baseBranch = m.baseBranch
		}

		err := m.gitManager.Create(path, sessionName, newBranch, baseBranch)
		return worktreeCreatedWithSessionMsg{err: err, path: path, branch: sessionName, sessionName: sessionName}
	}
}

func (m Model) deleteWorktree(path, branch string, force bool) tea.Cmd {
	return func() tea.Msg {
		// First remove the worktree
		err := m.gitManager.Remove(path, force)
		if err != nil {
			return worktreeDeletedMsg{err: err}
		}

		// Clean up branch-specific config data (PRs, Claude initialization, etc.)
		// This prevents config file bloat and removes stale references
		if m.configManager != nil {
			_ = m.configManager.CleanupBranch(m.repoPath, branch) // Ignore error, not critical
		}

		// Then kill the associated tmux session if it exists
		sessionName := m.sessionManager.SanitizeName(branch)
		_ = m.sessionManager.Kill(sessionName) // Ignore error if session doesn't exist

		return worktreeDeletedMsg{err: nil}
	}
}

func (m Model) ensureWorktreeExists(worktreePath, branch string) tea.Cmd {
	return func() tea.Msg {
		err := m.gitManager.EnsureWorktreeExists(worktreePath, branch)
		return worktreeEnsuredMsg{err: err}
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

		// Rename session
		if err := m.sessionManager.RenameSession(oldSessionName, newSessionName); err != nil {
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

func (m Model) loadBaseBranch() tea.Cmd {
	return func() tea.Msg {
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

func (m Model) createPR(worktreePath, branch string, optionalTitle string, optionalDescription string) tea.Cmd {
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
			return prCreatedMsg{err: fmt.Errorf("base branch not set. Press 'b' to set base branch")}
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

		// Determine title: use provided title or generate from branch name
		title := optionalTitle
		if title == "" {
			title = strings.ReplaceAll(branch, "-", " ")
			title = strings.ReplaceAll(title, "_", " ")
			title = strings.Title(title)
		}

		// Use provided description or default to empty
		description := optionalDescription

		// Create draft PR
		prURL, err := m.githubManager.CreateDraftPR(worktreePath, branch, m.baseBranch, title, description)
		if err != nil {
			return prCreatedMsg{err: err, branch: branch, worktreePath: worktreePath}
		}

		return prCreatedMsg{prURL: prURL, branch: branch, worktreePath: worktreePath}
	}
}

// createOrUpdatePR creates a new PR or updates existing one if it already exists
func (m Model) createOrUpdatePR(worktreePath, branch string, title string, description string) tea.Cmd {
	return func() tea.Msg {
		if branch == "" {
			return prCreatedMsg{err: fmt.Errorf("branch name is empty"), branch: branch, worktreePath: worktreePath}
		}

		// Verify base branch is set
		if m.baseBranch == "" {
			return prCreatedMsg{err: fmt.Errorf("base branch not set. Press 'b' to set base branch"), branch: branch, worktreePath: worktreePath}
		}

		// Check if a PR already exists for this branch
		existingPRURL, err := m.githubManager.GetPRForBranch(worktreePath, branch)
		if err != nil {
			return prCreatedMsg{err: fmt.Errorf("failed to check for existing PR: %w", err), branch: branch, worktreePath: worktreePath}
		}

		// If PR exists, update it instead of creating a new one
		if existingPRURL != "" {
			if err := m.githubManager.UpdatePR(worktreePath, branch, title, description); err != nil {
				return prCreatedMsg{err: err, branch: branch, worktreePath: worktreePath}
			}
			return prCreatedMsg{prURL: existingPRURL, branch: branch, worktreePath: worktreePath}
		}

		// PR doesn't exist, create a new one
		prURL, err := m.githubManager.CreateDraftPR(worktreePath, branch, m.baseBranch, title, description)
		if err != nil {
			return prCreatedMsg{err: err, branch: branch, worktreePath: worktreePath}
		}

		return prCreatedMsg{prURL: prURL, branch: branch, worktreePath: worktreePath}
	}
}

// createPRRetry creates a PR without re-pushing (for when PR already exists with different title/description)
func (m Model) createPRRetry(worktreePath, branch string, title string, description string) tea.Cmd {
	// Use the new createOrUpdatePR instead
	return m.createOrUpdatePR(worktreePath, branch, title, description)
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

// autoCommitBeforePR automatically commits uncommitted changes before creating a PR
func (m Model) autoCommitBeforePR(worktreePath, branch string) tea.Cmd {
	return func() tea.Msg {
		// Auto-generate a commit message based on the branch name
		subject := strings.ReplaceAll(branch, "-", " ")
		subject = strings.ReplaceAll(subject, "_", " ")
		subject = strings.TrimSpace(subject)

		// Capitalize first letter
		if len(subject) > 0 {
			subject = strings.ToUpper(subject[:1]) + subject[1:]
		}

		_, err := m.gitManager.CreateCommit(worktreePath, subject, "")
		return autoCommitBeforePRMsg{worktreePath: worktreePath, branch: branch, err: err}
	}
}

// changeTheme changes the theme and saves it to config
func (m Model) changeTheme(themeName string) tea.Cmd {
	return func() tea.Msg {
		// Apply the theme
		if err := ApplyTheme(themeName); err != nil {
			return themeChangedMsg{theme: themeName, err: err}
		}

		// Save the theme to config
		if err := m.configManager.SetTheme(m.repoPath, themeName); err != nil {
			return themeChangedMsg{theme: themeName, err: err}
		}

		return themeChangedMsg{theme: themeName, err: nil}
	}
}

// generateCommitMessageWithAI generates a commit message using OpenRouter API
func (m Model) generateCommitMessageWithAI(worktreePath string) tea.Cmd {
	return func() tea.Msg {
		apiKey := m.configManager.GetOpenRouterAPIKey()
		if apiKey == "" {
			return commitMessageGeneratedMsg{err: fmt.Errorf("OpenRouter API key not configured")}
		}

		// Get the git diff as context
		diff, err := m.gitManager.GetDiff(worktreePath)
		if err != nil {
			return commitMessageGeneratedMsg{err: fmt.Errorf("failed to get diff: %w", err)}
		}

		if diff == "" {
			return commitMessageGeneratedMsg{err: fmt.Errorf("no changes to commit")}
		}

		// Call OpenRouter API
		model := m.configManager.GetOpenRouterModel()
		client := openrouter.NewClient(apiKey, model)
		subject, body, err := client.GenerateCommitMessage(diff)
		if err != nil {
			return commitMessageGeneratedMsg{err: fmt.Errorf("failed to generate commit message: %w", err)}
		}

		return commitMessageGeneratedMsg{subject: subject, body: body, err: nil}
	}
}

// generateRenameWithAI generates a branch name suggestion based on git changes
func (m Model) generateRenameWithAI(worktreePath, baseBranch string) tea.Cmd {
	return func() tea.Msg {
		apiKey := m.configManager.GetOpenRouterAPIKey()
		if apiKey == "" {
			return renameGeneratedMsg{err: fmt.Errorf("OpenRouter API key not configured")}
		}

		// Get uncommitted changes
		diff := ""
		uncommittedDiff, _ := m.gitManager.GetDiff(worktreePath)
		if uncommittedDiff != "" {
			diff = uncommittedDiff
		} else if baseBranch != "" {
			// No uncommitted changes, try to get diff from base branch
			baseDiff, _ := m.gitManager.GetDiffFromBase(worktreePath, baseBranch)
			diff = baseDiff
		}

		// If still no changes, return error
		if diff == "" {
			return renameGeneratedMsg{err: fmt.Errorf("no changes detected to generate branch name")}
		}

		// Call OpenRouter API
		model := m.configManager.GetOpenRouterModel()
		client := openrouter.NewClient(apiKey, model)
		name, err := client.GenerateBranchName(diff)
		if err != nil {
			return renameGeneratedMsg{err: fmt.Errorf("failed to generate branch name: %w", err)}
		}

		return renameGeneratedMsg{name: name, err: nil}
	}
}

// generateBranchNameForPR generates an AI branch name for PR creation
func (m Model) generateBranchNameForPR(worktreePath, oldBranch, baseBranch string) tea.Cmd {
	return func() tea.Msg {
		apiKey := m.configManager.GetOpenRouterAPIKey()
		if apiKey == "" {
			return prBranchNameGeneratedMsg{
				oldBranchName: oldBranch,
				worktreePath:  worktreePath,
				err:           fmt.Errorf("API key not configured"),
			}
		}

		// Get diff (uncommitted first, then from base)
		diff := ""
		uncommittedDiff, _ := m.gitManager.GetDiff(worktreePath)
		if uncommittedDiff != "" {
			diff = uncommittedDiff
		} else if baseBranch != "" {
			baseDiff, _ := m.gitManager.GetDiffFromBase(worktreePath, baseBranch)
			diff = baseDiff
		}

		// No changes to generate from
		if diff == "" {
			return prBranchNameGeneratedMsg{
				oldBranchName: oldBranch,
				worktreePath:  worktreePath,
				err:           fmt.Errorf("no changes to generate name from"),
			}
		}

		// Call AI
		model := m.configManager.GetOpenRouterModel()
		client := openrouter.NewClient(apiKey, model)
		newName, err := client.GenerateBranchName(diff)

		return prBranchNameGeneratedMsg{
			oldBranchName: oldBranch,
			newBranchName: newName,
			worktreePath:  worktreePath,
			err:           err,
		}
	}
}

// deleteRemoteBranchForPR deletes the old remote branch during PR creation
func (m Model) deleteRemoteBranchForPR(worktreePath, oldBranch, newBranch string) tea.Cmd {
	return func() tea.Msg {
		err := m.gitManager.DeleteRemoteBranch(worktreePath, oldBranch)
		return prRemoteBranchDeletedMsg{
			oldBranchName: oldBranch,
			newBranchName: newBranch,
			worktreePath:  worktreePath,
			err:           err,
		}
	}
}

// renameBranchForPR renames a branch during PR creation
func (m Model) renameBranchForPR(oldName, newName, worktreePath string) tea.Cmd {
	return func() tea.Msg {
		err := m.gitManager.RenameBranchInWorktree(worktreePath, oldName, newName)
		return prBranchRenamedMsg{
			oldBranchName: oldName,
			newBranchName: newName,
			worktreePath:  worktreePath,
			err:           err,
		}
	}
}

// generatePRContent generates AI-powered PR title and description
func (m Model) generatePRContent(worktreePath, branchName, baseBranch string) tea.Cmd {
	return func() tea.Msg {
		apiKey := m.configManager.GetOpenRouterAPIKey()
		if apiKey == "" {
			return prContentGeneratedMsg{
				worktreePath: worktreePath,
				branch:       branchName,
				err:          fmt.Errorf("API key not configured"),
			}
		}

		// Get diff (uncommitted first, then from base)
		diff := ""
		uncommittedDiff, _ := m.gitManager.GetDiff(worktreePath)
		if uncommittedDiff != "" {
			diff = uncommittedDiff
		} else if baseBranch != "" {
			baseDiff, _ := m.gitManager.GetDiffFromBase(worktreePath, baseBranch)
			diff = baseDiff
		}

		// No changes to generate from
		if diff == "" {
			return prContentGeneratedMsg{
				worktreePath: worktreePath,
				branch:       branchName,
				err:          fmt.Errorf("no changes to generate PR content from"),
			}
		}

		// Call AI to generate title and description
		model := m.configManager.GetOpenRouterModel()
		client := openrouter.NewClient(apiKey, model)
		title, description, err := client.GeneratePRContent(diff)

		return prContentGeneratedMsg{
			title:        title,
			description:  description,
			worktreePath: worktreePath,
			branch:       branchName,
			err:          err,
		}
	}
}

// testOpenRouterAPIKey tests the OpenRouter API key to verify it works
func (m Model) testOpenRouterAPIKey(apiKey, model string) tea.Cmd {
	return func() tea.Msg {
		if apiKey == "" {
			return apiKeyTestedMsg{success: false, err: fmt.Errorf("API key is empty")}
		}

		// Create a test client and make a simple API call
		client := openrouter.NewClient(apiKey, model)

		// Make a simple test prompt
		testPrompt := "Say 'API key working' (only say that phrase, nothing else)"
		_, _, err := client.GenerateCommitMessage(testPrompt)
		if err != nil {
			return apiKeyTestedMsg{success: false, err: err}
		}

		return apiKeyTestedMsg{success: true, err: nil}
	}
}

// refreshPRStatuses refreshes the status of all PRs for the selected worktree
func (m Model) refreshPRStatuses() tea.Cmd {
	return func() tea.Msg {
		if m.selectedIndex < 0 || m.selectedIndex >= len(m.worktrees) {
			return prStatusesRefreshedMsg{err: fmt.Errorf("no worktree selected")}
		}

		worktree := m.worktrees[m.selectedIndex]
		prs := m.configManager.GetPRs(m.repoPath, worktree.Branch)

		// Update the status of each PR
		for _, pr := range prs {
			status, err := m.githubManager.GetPRStatus(pr.URL)
			if err == nil {
				_ = m.configManager.UpdatePRStatus(m.repoPath, worktree.Branch, pr.URL, status)
			}
		}

		// Reload worktrees to get updated PR info
		worktrees, err := m.gitManager.List(m.baseBranch)
		if err != nil {
			return prStatusesRefreshedMsg{err: err}
		}

		// Load PR info into worktrees
		for i := range worktrees {
			worktrees[i].PRs = m.configManager.GetPRs(m.repoPath, worktrees[i].Branch)
		}

		return prStatusesRefreshedMsg{err: nil}
	}
}

// Push-only command functions (without PR creation)

// generateBranchNameForPush generates an AI branch name for push operation
func (m Model) generateBranchNameForPush(worktreePath, oldBranch, baseBranch string) tea.Cmd {
	return func() tea.Msg {
		apiKey := m.configManager.GetOpenRouterAPIKey()
		if apiKey == "" {
			return pushBranchNameGeneratedMsg{
				oldBranchName: oldBranch,
				worktreePath:  worktreePath,
				err:           fmt.Errorf("API key not configured"),
			}
		}

		// Get diff (uncommitted first, then from base)
		diff := ""
		uncommittedDiff, _ := m.gitManager.GetDiff(worktreePath)
		if uncommittedDiff != "" {
			diff = uncommittedDiff
		} else if baseBranch != "" {
			baseDiff, _ := m.gitManager.GetDiffFromBase(worktreePath, baseBranch)
			diff = baseDiff
		}

		// No changes to generate from
		if diff == "" {
			return pushBranchNameGeneratedMsg{
				oldBranchName: oldBranch,
				worktreePath:  worktreePath,
				err:           fmt.Errorf("no changes to generate name from"),
			}
		}

		// Call AI
		model := m.configManager.GetOpenRouterModel()
		client := openrouter.NewClient(apiKey, model)
		newName, err := client.GenerateBranchName(diff)

		return pushBranchNameGeneratedMsg{
			oldBranchName: oldBranch,
			newBranchName: newName,
			worktreePath:  worktreePath,
			err:           err,
		}
	}
}

// deleteRemoteBranchForPush deletes the old remote branch during push operation
func (m Model) deleteRemoteBranchForPush(worktreePath, oldBranch, newBranch string) tea.Cmd {
	return func() tea.Msg {
		err := m.gitManager.DeleteRemoteBranch(worktreePath, oldBranch)
		return pushRemoteBranchDeletedMsg{
			oldBranchName: oldBranch,
			newBranchName: newBranch,
			worktreePath:  worktreePath,
			err:           err,
		}
	}
}

// renameBranchForPush renames a branch during push operation
func (m Model) renameBranchForPush(oldName, newName, worktreePath string) tea.Cmd {
	return func() tea.Msg {
		err := m.gitManager.RenameBranchInWorktree(worktreePath, oldName, newName)
		return pushBranchRenamedMsg{
			oldBranchName: oldName,
			newBranchName: newName,
			worktreePath:  worktreePath,
			err:           err,
		}
	}
}

// pushBranch pushes the branch to remote without creating a PR
func (m Model) pushBranch(worktreePath, branch string) tea.Cmd {
	return func() tea.Msg {
		// Check if the branch has any commits
		hasCommits, err := m.gitManager.HasCommits(worktreePath)
		if err != nil {
			return pushCompletedMsg{branch: branch, err: fmt.Errorf("failed to check for commits: %w", err)}
		}
		if !hasCommits {
			return pushCompletedMsg{branch: branch, err: fmt.Errorf("no commits to push")}
		}

		// Push the branch
		if err := m.gitManager.Push(worktreePath, branch); err != nil {
			return pushCompletedMsg{branch: branch, err: fmt.Errorf("failed to push: %w", err)}
		}

		return pushCompletedMsg{branch: branch, err: nil}
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

func (m Model) filterPRs(query string) []github.PRInfo {
	if query == "" {
		return m.prs
	}

	var filtered []github.PRInfo
	queryLower := strings.ToLower(query)
	for _, pr := range m.prs {
		// Search in title, author, and head branch name
		if strings.Contains(strings.ToLower(pr.Title), queryLower) ||
			strings.Contains(strings.ToLower(pr.Author.Login), queryLower) ||
			strings.Contains(strings.ToLower(pr.HeadRefName), queryLower) {
			filtered = append(filtered, pr)
		}
	}
	return filtered
}

// GetSwitchInfo returns the switch information (for shell integration)
func (m Model) GetSwitchInfo() SwitchInfo {
	return m.switchInfo
}

// GetConfigManager returns the config manager for access from main.go
func (m Model) GetConfigManager() *config.Manager {
	return m.configManager
}

// loadSessions loads tmux sessions for the current repository only
func (m Model) loadSessions() tea.Cmd {
	return func() tea.Msg {
		sessions, err := m.sessionManager.List(m.repoPath)
		if err != nil {
			return statusMsg("Failed to load sessions")
		}
		return sessionsLoadedMsg{sessions: sessions}
	}
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

// checkAndPullFromBase fetches first, then checks if behind, then pulls if needed
// This ensures we check against actual remote state, not stale cached data
func (m Model) checkAndPullFromBase(worktreePath, baseBranch string) tea.Cmd {
	return func() tea.Msg {
		// First: Fetch to get latest remote refs
		if err := m.gitManager.FetchRemote(); err != nil {
			return branchPulledMsg{err: fmt.Errorf("failed to fetch: %w", err)}
		}

		// Second: Check if actually behind by comparing fresh refs
		_, behindCount, err := m.gitManager.GetBranchStatus(worktreePath, "", baseBranch)
		if err != nil {
			return branchPulledMsg{err: fmt.Errorf("failed to check branch status: %w", err)}
		}

		// Third: If not behind, inform user
		if behindCount == 0 {
			// Not behind - return special message to show in UI
			return branchPulledMsg{err: fmt.Errorf("worktree is already up-to-date with base branch"), hadConflict: false}
		}

		// Fourth: Pull if behind
		err = m.gitManager.MergeBranch(worktreePath, baseBranch)
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

// refreshWithPull fetches latest commits from remote and pulls all worktrees
// Automatically pulls changes into ALL worktrees (main repo + workspace branches)
// Skips worktrees with uncommitted changes to prevent merge conflicts
func (m Model) refreshWithPull() tea.Cmd {
	return func() tea.Msg {
		msg := refreshWithPullMsg{
			updatedBranches: make(map[string]int),
			upToDate:        true,
		}

		// Fetch all updates from remote first to get latest refs
		if err := m.gitManager.FetchRemote(); err != nil {
			return refreshWithPullMsg{err: fmt.Errorf("failed to fetch updates: %w", err)}
		}

		// Pull all worktrees (both main repo and workspace branches)
		for _, wt := range m.worktrees {
			if wt.Branch == "" {
				continue // Skip if no branch is checked out
			}

			// Check if this worktree has uncommitted changes
			hasUncommitted, _ := m.gitManager.HasUncommittedChanges(wt.Path)
			if hasUncommitted {
				continue // Skip pulling if there are uncommitted changes
			}

			// Pull this worktree's current branch
			var output string
			var err error

			if wt.IsCurrent {
				// For main repo, use PullCurrentBranchWithOutput
				output, err = m.gitManager.PullCurrentBranchWithOutput(m.repoPath, wt.Branch)
			} else {
				// For workspace branches, use PullBranchInPathWithOutput
				output, err = m.gitManager.PullBranchInPathWithOutput(wt.Path, wt.Branch)
			}

			if err != nil {
				// Pull failed for this worktree, but continue with others
				// Store the first error if no error was already recorded
				if msg.pullErr == nil {
					msg.pullErr = fmt.Errorf("failed to pull %s: %w", wt.Branch, err)
				}
				continue
			}

			// Parse the output to extract commit count
			isUpToDate, commitCount := m.gitManager.ParsePullOutput(output)
			if !isUpToDate && commitCount > 0 {
				msg.updatedBranches[wt.Branch] = commitCount
				msg.upToDate = false
			}
		}

		// Worktree list will be reloaded by the Update handler
		// This recalculates ahead/behind counts based on fetched refs
		return msg
	}
}

// scheduleActivityCheck schedules periodic activity checks
func (m Model) scheduleActivityCheck() tea.Cmd {
	return tea.Every(2*time.Second, func(t time.Time) tea.Msg {
		return activityTickMsg(t)
	})
}

// animateSpinner sends a spinner tick message with 100ms interval
// Continues animating as long as generatingCommit is true
func (m Model) animateSpinner() tea.Cmd {
	return tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
		return spinnerTickMsg{}
	})
}

// animateRenameSpinner sends a spinner tick message for rename modal
func (m Model) animateRenameSpinner() tea.Cmd {
	return tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
		return renameSpinnerTickMsg{}
	})
}

// checkSessionActivity checks for recent session activity in current repository
func (m Model) checkSessionActivity() tea.Cmd {
	return func() tea.Msg {
		sessions, err := m.sessionManager.List(m.repoPath)
		if err != nil {
			return activityCheckedMsg{sessions: []session.Session{}, err: err}
		}
		return activityCheckedMsg{sessions: sessions, err: nil}
	}
}

// showNotification displays a notification and optionally schedules it to be hidden after a duration
func (m *Model) showNotification(message string, notifType NotificationType, autoClearAfter *time.Duration) tea.Cmd {
	// Generate unique ID for this notification
	m.notificationID++
	notifID := m.notificationID

	notif := &Notification{
		ID:        notifID,
		Message:   message,
		Type:      notifType,
		Timestamp: time.Now(),
	}

	// If we have a duration, store it
	if autoClearAfter != nil && *autoClearAfter > 0 {
		notif.Duration = *autoClearAfter
	}

	// Replace any existing notification (no queueing)
	m.notification = notif
	m.notificationVisible = true
	m.notificationStarted = time.Now()

	if autoClearAfter != nil && *autoClearAfter > 0 {
		return m.scheduleNotificationHide(notifID, *autoClearAfter)
	}
	return nil
}

// Helper methods for common notification types

// showSuccessNotification displays a success notification with auto-clear (2 seconds)
func (m *Model) showSuccessNotification(message string, autoClearAfter time.Duration) tea.Cmd {
	return m.showNotification(message, NotificationSuccess, &autoClearAfter)
}

// showErrorNotification displays an error notification with auto-clear (5 seconds)
func (m *Model) showErrorNotification(message string, autoClearAfter time.Duration) tea.Cmd {
	return m.showNotification(message, NotificationError, &autoClearAfter)
}

// showWarningNotification displays a warning notification (3 seconds auto-clear)
func (m *Model) showWarningNotification(message string) tea.Cmd {
	duration := 3 * time.Second
	return m.showNotification(message, NotificationWarning, &duration)
}

// showInfoNotification displays an info notification (3 seconds auto-clear)
func (m *Model) showInfoNotification(message string) tea.Cmd {
	duration := 3 * time.Second
	return m.showNotification(message, NotificationInfo, &duration)
}

// runScript executes a script and captures its output with real-time streaming
// Uses cmd.Start() so the process can be killed later
// Returns immediately and starts polling for output updates
func (m *Model) runScript(scriptName, scriptCmd, worktreePath string, scriptIdx int) tea.Cmd {
	return func() tea.Msg {
		cmd := exec.Command("bash", "-c", scriptCmd)
		cmd.Dir = worktreePath

		// Create pipes for streaming stdout and stderr
		stdoutPipe, err := cmd.StdoutPipe()
		if err != nil {
			return scriptOutputStreamMsg{scriptName: scriptName, output: fmt.Sprintf("Failed to create stdout pipe: %v\n", err), finished: true}
		}
		stderrPipe, err := cmd.StderrPipe()
		if err != nil {
			return scriptOutputStreamMsg{scriptName: scriptName, output: fmt.Sprintf("Failed to create stderr pipe: %v\n", err), finished: true}
		}

		// Start the process
		if err := cmd.Start(); err != nil {
			return scriptOutputStreamMsg{scriptName: scriptName, output: fmt.Sprintf("Failed to start script: %v\n", err), finished: true}
		}

		// Store PID in the script execution so we can kill it later
		if scriptIdx < len(m.runningScripts) {
			m.runningScripts[scriptIdx].pid = cmd.Process.Pid
		}

		// Create shared buffer for this script
		scriptBuffersMutex.Lock()
		scriptOutputBuffers[scriptIdx] = &scriptOutputBuffer{
			cmd:      cmd,
			finished: false,
		}
		scriptBuffersMutex.Unlock()

		// Goroutine to read from stdout
		go func() {
			scanner := bufio.NewScanner(stdoutPipe)
			for scanner.Scan() {
				scriptBuffersMutex.RLock()
				buf := scriptOutputBuffers[scriptIdx]
				scriptBuffersMutex.RUnlock()
				if buf != nil {
					buf.mutex.Lock()
					buf.buffer.WriteString(scanner.Text() + "\n")
					buf.mutex.Unlock()
				}
			}
		}()

		// Goroutine to read from stderr
		go func() {
			scanner := bufio.NewScanner(stderrPipe)
			for scanner.Scan() {
				scriptBuffersMutex.RLock()
				buf := scriptOutputBuffers[scriptIdx]
				scriptBuffersMutex.RUnlock()
				if buf != nil {
					buf.mutex.Lock()
					buf.buffer.WriteString(scanner.Text() + "\n")
					buf.mutex.Unlock()
				}
			}
		}()

		// Goroutine to wait for process completion
		go func() {
			_ = cmd.Wait()
			scriptBuffersMutex.RLock()
			buf := scriptOutputBuffers[scriptIdx]
			scriptBuffersMutex.RUnlock()
			if buf != nil {
				buf.mutex.Lock()
				buf.finished = true
				buf.mutex.Unlock()
			}
		}()

		// Start polling for output updates
		return scriptOutputPollMsg{scriptIdx: scriptIdx}
	}
}

// pollScriptOutput polls for script output updates every 200ms
func (m *Model) pollScriptOutput(scriptIdx int) tea.Cmd {
	return tea.Tick(200*time.Millisecond, func(t time.Time) tea.Msg {
		return scriptOutputPollMsg{scriptIdx: scriptIdx}
	})
}

// scheduleNotificationHide schedules the notification to be hidden after specified duration
func (m Model) scheduleNotificationHide(id int64, duration time.Duration) tea.Cmd {
	return tea.Sequence(
		tea.Tick(duration, func(t time.Time) tea.Msg {
			return notificationHideMsg{id: id}
		}),
	)
}

// scheduleClaudeStatusCheck schedules a periodic check of Claude status in active sessions
func (m Model) scheduleClaudeStatusCheck() tea.Cmd {
	return tea.Tick(1500*time.Millisecond, func(t time.Time) tea.Msg {
		return claudeStatusTickMsg(t)
	})
}

// scheduleClaudeStatusAnimationTick schedules animation frame updates for busy indicators
func (m Model) scheduleClaudeStatusAnimationTick() tea.Cmd {
	return tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
		return spinnerTickMsg{}
	})
}

// pollClaudeStatuses checks the status of all active Claude sessions
func (m Model) pollClaudeStatuses() tea.Cmd {
	return func() tea.Msg {
		// Check each active session
		for _, sess := range m.sessions {
			// Create detector if it doesn't exist
			if _, exists := m.statusDetectors[sess.Name]; !exists {
				m.statusDetectors[sess.Name] = session.NewStatusDetector(sess.Name)
			}

			detector := m.statusDetectors[sess.Name]
			status := detector.GetStatus()

			// Update status map
			m.claudeStatuses[sess.Name] = status
		}
		return nil
	}
}

// gitRepoOpenedMsg is sent when the git repository is opened in browser
type gitRepoOpenedMsg struct {
	err error
}

// openGitRepo opens the git repository in the default browser
func (m Model) openGitRepo() tea.Cmd {
	return func() tea.Msg {
		selected := m.selectedWorktree()
		if selected == nil {
			return gitRepoOpenedMsg{err: fmt.Errorf("no worktree selected")}
		}

		// Get the branch URL for the selected worktree
		url, err := m.gitManager.GetBranchRemoteURL(selected.Branch)
		if err != nil {
			return gitRepoOpenedMsg{err: err}
		}

		// Open in browser
		if err := git.OpenInBrowser(url); err != nil {
			return gitRepoOpenedMsg{err: err}
		}

		return gitRepoOpenedMsg{err: nil}
	}
}

// sortWorktrees sorts the worktree list by last modified time (most recent first)
func (m *Model) sortWorktrees() {
	if len(m.worktrees) == 0 {
		return
	}

	// Sort: root worktree (IsCurrent=true) always first, then by LastModified (most recent first)
	sort.SliceStable(m.worktrees, func(i, j int) bool {
		// Root worktree always comes first
		if m.worktrees[i].IsCurrent {
			return true
		}
		if m.worktrees[j].IsCurrent {
			return false
		}

		// Otherwise, sort by last modified time (most recent first)
		return m.worktrees[i].LastModified.After(m.worktrees[j].LastModified)
	})
}

// markPRReady marks a draft PR as ready for review
func (m Model) markPRReady(worktreePath, prURL string) tea.Cmd {
	return func() tea.Msg {
		selected := m.selectedWorktree()
		if selected == nil {
			return prMarkedReadyMsg{prURL: prURL, err: fmt.Errorf("no worktree selected")}
		}

		err := m.githubManager.MarkPRReady(selected.Path, prURL)
		return prMarkedReadyMsg{prURL: prURL, err: err}
	}
}

// mergePR merges a pull request using the specified merge method
func (m Model) mergePR(worktreePath, prURL, mergeMethod string) tea.Cmd {
	return func() tea.Msg {
		selected := m.selectedWorktree()
		if selected == nil {
			return prMergedMsg{prURL: prURL, branch: "", err: fmt.Errorf("no worktree selected")}
		}

		err := m.githubManager.MergePR(selected.Path, prURL, mergeMethod)
		return prMergedMsg{prURL: prURL, branch: selected.Branch, err: err}
	}
}

// Message types for PR merge operations

type prMarkedReadyMsg struct {
	prURL string
	err   error
}

type prMergedMsg struct {
	prURL  string
	branch string
	err    error
}
