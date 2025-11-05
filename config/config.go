package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"github.com/coollabsio/jean/openrouter"
)

// AIPrompts represents customizable AI prompts for various generation tasks
type AIPrompts struct {
	CommitMessage string `json:"commit_message,omitempty"` // Custom prompt for commit message generation
	BranchName    string `json:"branch_name,omitempty"`    // Custom prompt for branch name generation
	PRContent     string `json:"pr_content,omitempty"`     // Custom prompt for PR title and description generation
}

// Config represents the global jean configuration
type Config struct {
	Repositories        map[string]*RepoConfig `json:"repositories"`
	LastUpdateCheckTime string                 `json:"lastUpdateCheckTime"` // RFC3339 format
	DefaultTheme        string                 `json:"default_theme,omitempty"` // Global default theme, "" = matrix
	OpenRouterAPIKey    string                 `json:"openrouter_api_key,omitempty"` // API key for OpenRouter AI
	OpenRouterModel     string                 `json:"openrouter_model,omitempty"` // OpenRouter model, "" = default haiku
	AICommitEnabled     bool                   `json:"ai_commit_enabled,omitempty"` // Enable AI commit message generation
	AIBranchNameEnabled bool                   `json:"ai_branch_name_enabled,omitempty"` // Enable AI branch name generation
	DebugLoggingEnabled bool                   `json:"debug_logging_enabled"` // Enable debug logging to temp files
	AIPrompts           *AIPrompts             `json:"ai_prompts,omitempty"` // Customizable AI prompts
	WrapperChecksums    map[string]string      `json:"wrapper_checksums,omitempty"` // Shell -> SHA256 checksum of installed wrapper
	Onboarded           bool                   `json:"onboarded"` // Whether the user has completed the onboarding flow
}

// PRInfo represents information about a pull request
type PRInfo struct {
	URL       string `json:"url"`
	Status    string `json:"status"` // "open", "merged", or "closed"
	CreatedAt string `json:"created_at,omitempty"` // RFC3339 format
	Branch    string `json:"branch"`
	PRNumber  int    `json:"pr_number,omitempty"` // GitHub PR number (e.g., 42 from github.com/owner/repo/pull/42)
	Title     string `json:"title,omitempty"`     // PR title for display
	Author    string `json:"author,omitempty"`    // Author login for display
}

// RepoConfig represents configuration for a specific repository
type RepoConfig struct {
	BaseBranch         string            `json:"base_branch"`
	LastSelectedBranch string            `json:"last_selected_branch,omitempty"`
	Editor             string            `json:"editor,omitempty"`
	AutoFetchInterval  int               `json:"auto_fetch_interval,omitempty"` // in seconds, 0 = use default (10s)
	Theme              string            `json:"theme,omitempty"`               // Per-repo theme override, "" = use global default
	PRs                map[string][]PRInfo `json:"prs,omitempty"`                 // branch -> list of PRs
	InitializedClaudes map[string]bool   `json:"initialized_claudes,omitempty"` // branch -> whether Claude has been started
}

// Manager handles configuration loading and saving
type Manager struct {
	configPath string
	config     *Config
}

// NewManager creates a new configuration manager
func NewManager() (*Manager, error) {
	// Get user home directory
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	// Create config directory: ~/.config/jean
	configDir := filepath.Join(home, ".config", "jean")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create config directory: %w", err)
	}

	configPath := filepath.Join(configDir, "config.json")

	m := &Manager{
		configPath: configPath,
	}

	// Load existing config or create new one
	if err := m.load(); err != nil {
		// If file doesn't exist, create empty config
		m.config = &Config{
			Repositories: make(map[string]*RepoConfig),
		}
	}

	return m, nil
}

// load reads the configuration from disk
func (m *Manager) load() error {
	data, err := os.ReadFile(m.configPath)
	if err != nil {
		return err
	}

	m.config = &Config{}
	return json.Unmarshal(data, m.config)
}

// save writes the configuration to disk
func (m *Manager) save() error {
	data, err := json.MarshalIndent(m.config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	return os.WriteFile(m.configPath, data, 0644)
}

// GetBaseBranch returns the base branch for a repository
func (m *Manager) GetBaseBranch(repoPath string) string {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		return repo.BaseBranch
	}
	return ""
}

// SetBaseBranch sets the base branch for a repository
func (m *Manager) SetBaseBranch(repoPath, branch string) error {
	if m.config.Repositories == nil {
		m.config.Repositories = make(map[string]*RepoConfig)
	}

	if _, ok := m.config.Repositories[repoPath]; !ok {
		m.config.Repositories[repoPath] = &RepoConfig{}
	}

	m.config.Repositories[repoPath].BaseBranch = branch
	return m.save()
}

// GetRepoConfig returns the configuration for a specific repository
func (m *Manager) GetRepoConfig(repoPath string) *RepoConfig {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		return repo
	}
	return &RepoConfig{}
}

// GetLastSelectedBranch returns the last selected branch for a repository
func (m *Manager) GetLastSelectedBranch(repoPath string) string {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		return repo.LastSelectedBranch
	}
	return ""
}

// SetLastSelectedBranch sets the last selected branch for a repository
func (m *Manager) SetLastSelectedBranch(repoPath, branch string) error {
	if m.config.Repositories == nil {
		m.config.Repositories = make(map[string]*RepoConfig)
	}

	if _, ok := m.config.Repositories[repoPath]; !ok {
		m.config.Repositories[repoPath] = &RepoConfig{}
	}

	m.config.Repositories[repoPath].LastSelectedBranch = branch
	return m.save()
}

// GetEditor returns the preferred editor for a repository
func (m *Manager) GetEditor(repoPath string) string {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		if repo.Editor != "" {
			return repo.Editor
		}
	}
	return "code" // Default to VS Code
}

// SetEditor sets the preferred editor for a repository
func (m *Manager) SetEditor(repoPath, editor string) error {
	if m.config.Repositories == nil {
		m.config.Repositories = make(map[string]*RepoConfig)
	}

	if _, ok := m.config.Repositories[repoPath]; !ok {
		m.config.Repositories[repoPath] = &RepoConfig{}
	}

	m.config.Repositories[repoPath].Editor = editor
	return m.save()
}

// GetAutoFetchInterval returns the auto-fetch interval for a repository
// Returns the configured interval in seconds, or 10 if not set
func (m *Manager) GetAutoFetchInterval(repoPath string) int {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		if repo.AutoFetchInterval > 0 {
			return repo.AutoFetchInterval
		}
	}
	return 10 // Default to 10 seconds
}

// SetAutoFetchInterval sets the auto-fetch interval for a repository
func (m *Manager) SetAutoFetchInterval(repoPath string, interval int) error {
	if m.config.Repositories == nil {
		m.config.Repositories = make(map[string]*RepoConfig)
	}

	if _, ok := m.config.Repositories[repoPath]; !ok {
		m.config.Repositories[repoPath] = &RepoConfig{}
	}

	m.config.Repositories[repoPath].AutoFetchInterval = interval
	return m.save()
}

// GetLastUpdateCheckTime returns the last update check time
func (m *Manager) GetLastUpdateCheckTime() string {
	return m.config.LastUpdateCheckTime
}

// SetLastUpdateCheckTime sets the last update check time
func (m *Manager) SetLastUpdateCheckTime(timestamp string) error {
	m.config.LastUpdateCheckTime = timestamp
	return m.save()
}

// GetTheme returns the theme for a repository
// Returns per-repo theme if set, otherwise returns global default theme
// Returns "coolify" if no theme is configured
func (m *Manager) GetTheme(repoPath string) string {
	// Check if repo has a per-repo theme override
	if repo, ok := m.config.Repositories[repoPath]; ok {
		if repo.Theme != "" {
			return repo.Theme
		}
	}

	// Fall back to global default theme
	if m.config.DefaultTheme != "" {
		return m.config.DefaultTheme
	}

	// Default to coolify theme
	return "coolify"
}

// SetTheme sets the theme for a specific repository
// If theme is empty string, it will use the global default
func (m *Manager) SetTheme(repoPath, theme string) error {
	if m.config.Repositories == nil {
		m.config.Repositories = make(map[string]*RepoConfig)
	}

	if _, ok := m.config.Repositories[repoPath]; !ok {
		m.config.Repositories[repoPath] = &RepoConfig{}
	}

	m.config.Repositories[repoPath].Theme = theme
	return m.save()
}

// SetGlobalTheme sets the global default theme for all repositories
func (m *Manager) SetGlobalTheme(theme string) error {
	m.config.DefaultTheme = theme
	return m.save()
}

// GetGlobalTheme returns the global default theme
// Returns "coolify" if not set
func (m *Manager) GetGlobalTheme() string {
	if m.config.DefaultTheme != "" {
		return m.config.DefaultTheme
	}
	return "coolify"
}

// GetOpenRouterAPIKey returns the OpenRouter API key
func (m *Manager) GetOpenRouterAPIKey() string {
	return m.config.OpenRouterAPIKey
}

// SetOpenRouterAPIKey sets the OpenRouter API key
func (m *Manager) SetOpenRouterAPIKey(apiKey string) error {
	m.config.OpenRouterAPIKey = apiKey
	return m.save()
}

// GetOpenRouterModel returns the OpenRouter model
// Returns "openai/gpt-4o-mini" if not set
func (m *Manager) GetOpenRouterModel() string {
	if m.config.OpenRouterModel != "" {
		return m.config.OpenRouterModel
	}
	return "openai/gpt-4o-mini"
}

// SetOpenRouterModel sets the OpenRouter model
func (m *Manager) SetOpenRouterModel(model string) error {
	m.config.OpenRouterModel = model
	return m.save()
}

// GetAICommitEnabled returns whether AI commit message generation is enabled
func (m *Manager) GetAICommitEnabled() bool {
	return m.config.AICommitEnabled
}

// SetAICommitEnabled sets whether AI commit message generation is enabled
func (m *Manager) SetAICommitEnabled(enabled bool) error {
	m.config.AICommitEnabled = enabled
	return m.save()
}

// GetAIBranchNameEnabled returns whether AI branch name generation is enabled
func (m *Manager) GetAIBranchNameEnabled() bool {
	return m.config.AIBranchNameEnabled
}

// SetAIBranchNameEnabled sets whether AI branch name generation is enabled
func (m *Manager) SetAIBranchNameEnabled(enabled bool) error {
	m.config.AIBranchNameEnabled = enabled
	return m.save()
}

// GetDebugLoggingEnabled returns whether debug logging is enabled
func (m *Manager) GetDebugLoggingEnabled() bool {
	return m.config.DebugLoggingEnabled
}

// SetDebugLoggingEnabled sets whether debug logging is enabled
func (m *Manager) SetDebugLoggingEnabled(enabled bool) error {
	m.config.DebugLoggingEnabled = enabled
	return m.save()
}

// GetPRs returns all pull requests for a given branch
func (m *Manager) GetPRs(repoPath, branch string) []PRInfo {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		if repo.PRs != nil {
			if prs, ok := repo.PRs[branch]; ok {
				return prs
			}
		}
	}
	return []PRInfo{}
}

// GetLatestPR returns the most recent pull request for a given branch
func (m *Manager) GetLatestPR(repoPath, branch string) *PRInfo {
	prs := m.GetPRs(repoPath, branch)
	if len(prs) == 0 {
		return nil
	}
	return &prs[len(prs)-1]
}

// AddPR adds a pull request for a given branch
func (m *Manager) AddPR(repoPath, branch, url string, prNumber int, title string, author string) error {
	if m.config.Repositories == nil {
		m.config.Repositories = make(map[string]*RepoConfig)
	}

	if _, ok := m.config.Repositories[repoPath]; !ok {
		m.config.Repositories[repoPath] = &RepoConfig{}
	}

	repo := m.config.Repositories[repoPath]
	if repo.PRs == nil {
		repo.PRs = make(map[string][]PRInfo)
	}

	// Check if PR already exists
	for _, pr := range repo.PRs[branch] {
		if pr.URL == url {
			return nil // Already exists
		}
	}

	// Add new PR with "open" status by default
	prInfo := PRInfo{
		URL:      url,
		Status:   "open",
		Branch:   branch,
		PRNumber: prNumber,
		Title:    title,
		Author:   author,
	}
	repo.PRs[branch] = append(repo.PRs[branch], prInfo)
	return m.save()
}

// UpdatePRStatus updates the status of a pull request
func (m *Manager) UpdatePRStatus(repoPath, branch, url, status string) error {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		if repo.PRs != nil {
			if prs, ok := repo.PRs[branch]; ok {
				for i, pr := range prs {
					if pr.URL == url {
						prs[i].Status = status
						return m.save()
					}
				}
			}
		}
	}
	return nil
}

// RemovePR removes a pull request
func (m *Manager) RemovePR(repoPath, branch, url string) error {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		if repo.PRs != nil {
			if prs, ok := repo.PRs[branch]; ok {
				newPRs := []PRInfo{}
				for _, pr := range prs {
					if pr.URL != url {
						newPRs = append(newPRs, pr)
					}
				}
				repo.PRs[branch] = newPRs
				return m.save()
			}
		}
	}
	return nil
}

// HasPRs checks if there are any pull requests for a given branch
func (m *Manager) HasPRs(repoPath, branch string) bool {
	prs := m.GetPRs(repoPath, branch)
	return len(prs) > 0
}

// IsClaudeInitialized checks if a Claude session has been initialized for a branch
func (m *Manager) IsClaudeInitialized(repoPath, branch string) bool {
	if repo, ok := m.config.Repositories[repoPath]; ok {
		if repo.InitializedClaudes != nil {
			return repo.InitializedClaudes[branch]
		}
	}
	return false
}

// SetClaudeInitialized marks a branch as having an initialized Claude session
func (m *Manager) SetClaudeInitialized(repoPath, branch string) error {
	if m.config.Repositories == nil {
		m.config.Repositories = make(map[string]*RepoConfig)
	}

	if _, ok := m.config.Repositories[repoPath]; !ok {
		m.config.Repositories[repoPath] = &RepoConfig{}
	}

	repo := m.config.Repositories[repoPath]
	if repo.InitializedClaudes == nil {
		repo.InitializedClaudes = make(map[string]bool)
	}

	repo.InitializedClaudes[branch] = true
	// Only log debug info if debug logging is enabled
	if os.Getenv("JEAN_DEBUG_ENABLED") == "true" {
		fmt.Fprintf(os.Stderr, "DEBUG config: SetClaudeInitialized called for repo=%q branch=%q\n", repoPath, branch)
	}
	err := m.save()
	if err != nil && os.Getenv("JEAN_DEBUG_ENABLED") == "true" {
		fmt.Fprintf(os.Stderr, "DEBUG config: SetClaudeInitialized FAILED: %v\n", err)
	} else if err == nil && os.Getenv("JEAN_DEBUG_ENABLED") == "true" {
		fmt.Fprintf(os.Stderr, "DEBUG config: SetClaudeInitialized SUCCESS\n")
	}
	return err
}

// CleanupBranch removes all branch-specific data from config when a worktree is deleted
// This includes:
// - All pull requests for the branch
// - Claude initialization flag
// - Last selected branch reference (if it matches the deleted branch)
func (m *Manager) CleanupBranch(repoPath, branch string) error {
	repo, ok := m.config.Repositories[repoPath]
	if !ok {
		return nil // Nothing to clean up
	}

	// Remove all PRs for this branch
	if repo.PRs != nil {
		delete(repo.PRs, branch)
	}

	// Remove Claude initialization flag for this branch
	if repo.InitializedClaudes != nil {
		delete(repo.InitializedClaudes, branch)
	}

	// Clear last selected branch if it matches the deleted branch
	if repo.LastSelectedBranch == branch {
		repo.LastSelectedBranch = ""
	}

	return m.save()
}

// GetCommitPrompt returns the custom commit message prompt
// Returns the custom prompt if set, otherwise returns the default prompt
func (m *Manager) GetCommitPrompt() string {
	if m.config.AIPrompts != nil && m.config.AIPrompts.CommitMessage != "" {
		return m.config.AIPrompts.CommitMessage
	}
	return openrouter.GetDefaultCommitPrompt()
}

// SetCommitPrompt sets the custom commit message prompt
func (m *Manager) SetCommitPrompt(prompt string) error {
	if m.config.AIPrompts == nil {
		m.config.AIPrompts = &AIPrompts{}
	}
	m.config.AIPrompts.CommitMessage = prompt
	return m.save()
}

// GetBranchNamePrompt returns the custom branch name prompt
// Returns the custom prompt if set, otherwise returns the default prompt
func (m *Manager) GetBranchNamePrompt() string {
	if m.config.AIPrompts != nil && m.config.AIPrompts.BranchName != "" {
		return m.config.AIPrompts.BranchName
	}
	return openrouter.GetDefaultBranchNamePrompt()
}

// SetBranchNamePrompt sets the custom branch name prompt
func (m *Manager) SetBranchNamePrompt(prompt string) error {
	if m.config.AIPrompts == nil {
		m.config.AIPrompts = &AIPrompts{}
	}
	m.config.AIPrompts.BranchName = prompt
	return m.save()
}

// GetPRPrompt returns the custom PR content prompt
// Returns the custom prompt if set, otherwise returns the default prompt
func (m *Manager) GetPRPrompt() string {
	if m.config.AIPrompts != nil && m.config.AIPrompts.PRContent != "" {
		return m.config.AIPrompts.PRContent
	}
	return openrouter.GetDefaultPRPrompt()
}

// SetPRPrompt sets the custom PR content prompt
func (m *Manager) SetPRPrompt(prompt string) error {
	if m.config.AIPrompts == nil {
		m.config.AIPrompts = &AIPrompts{}
	}
	m.config.AIPrompts.PRContent = prompt
	return m.save()
}

// ResetAIPromptsToDefaults resets all AI prompts to their default values
func (m *Manager) ResetAIPromptsToDefaults() error {
	m.config.AIPrompts = &AIPrompts{} // Empty AIPrompts means use defaults
	return m.save()
}

// GetWrapperChecksum returns the stored checksum for a shell wrapper
// Returns empty string if no checksum is stored
func (m *Manager) GetWrapperChecksum(shell string) string {
	if m.config.WrapperChecksums == nil {
		return ""
	}
	return m.config.WrapperChecksums[shell]
}

// SetWrapperChecksum stores the checksum for a shell wrapper
func (m *Manager) SetWrapperChecksum(shell, checksum string) error {
	if m.config.WrapperChecksums == nil {
		m.config.WrapperChecksums = make(map[string]string)
	}
	m.config.WrapperChecksums[shell] = checksum
	return m.save()
}

// IsOnboarded returns whether the user has completed the onboarding flow
func (m *Manager) IsOnboarded() bool {
	return m.config.Onboarded
}

// SetOnboarded marks the onboarding flow as completed
func (m *Manager) SetOnboarded() error {
	m.config.Onboarded = true
	return m.save()
}
