package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config represents the global gcool configuration
type Config struct {
	Repositories        map[string]*RepoConfig `json:"repositories"`
	LastUpdateCheckTime string                 `json:"lastUpdateCheckTime"` // RFC3339 format
}

// RepoConfig represents configuration for a specific repository
type RepoConfig struct {
	BaseBranch         string `json:"base_branch"`
	LastSelectedBranch string `json:"last_selected_branch,omitempty"`
	Editor             string `json:"editor,omitempty"`
	AutoFetchInterval  int    `json:"auto_fetch_interval,omitempty"` // in seconds, 0 = use default (10s)
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

	// Create config directory: ~/.config/gcool
	configDir := filepath.Join(home, ".config", "gcool")
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
