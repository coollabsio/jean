package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const sessionPrefix = "gcool-"

// Session represents a tmux session
type Session struct {
	Name    string
	Branch  string
	Active  bool
	Windows int
}

// Manager handles tmux session operations
type Manager struct{}

// NewManager creates a new session manager
func NewManager() *Manager {
	return &Manager{}
}

// SanitizeName sanitizes a branch name for use as a tmux session name
// If isTerminal is true, appends "-terminal" suffix to differentiate from Claude sessions
func (m *Manager) SanitizeName(branch string) string {
	return m.sanitizeNameWithType(branch, false)
}

// SanitizeNameTerminal creates a terminal-only session name
func (m *Manager) SanitizeNameTerminal(branch string) string {
	return m.sanitizeNameWithType(branch, true)
}

// sanitizeNameWithType is the internal implementation
func (m *Manager) sanitizeNameWithType(branch string, isTerminal bool) string {
	// Replace invalid characters with hyphens
	reg := regexp.MustCompile(`[^a-zA-Z0-9\-_]`)
	sanitized := reg.ReplaceAllString(branch, "-")

	// Remove consecutive hyphens
	reg = regexp.MustCompile(`-+`)
	sanitized = reg.ReplaceAllString(sanitized, "-")

	// Trim hyphens from start/end
	sanitized = strings.Trim(sanitized, "-")

	if isTerminal {
		return sessionPrefix + sanitized + "-terminal"
	}
	return sessionPrefix + sanitized
}

// SessionExists checks if a tmux session with the given name exists
func (m *Manager) SessionExists(sessionName string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", sessionName)
	err := cmd.Run()
	return err == nil
}

// CreateOrAttach creates a new session or attaches to existing one
// If terminalOnly is true, creates/attaches to a terminal-only session (no Claude)
func (m *Manager) CreateOrAttach(path, branch string, autoStartClaude bool, terminalOnly bool) error {
	var sessionName string
	if terminalOnly {
		sessionName = m.SanitizeNameTerminal(branch)
	} else {
		sessionName = m.SanitizeName(branch)
	}

	if m.SessionExists(sessionName) {
		// Attach to existing session
		return m.Attach(sessionName)
	}

	// Create new session
	return m.Create(sessionName, path, autoStartClaude)
}

// Create creates a new tmux session in detached mode
func (m *Manager) Create(sessionName, path string, autoStartClaude bool) error {
	var cmd *exec.Cmd

	if autoStartClaude {
		// Create detached session and start claude
		cmd = exec.Command("tmux", "new-session", "-d", "-s", sessionName, "-c", path, "claude")
	} else {
		// Create detached session with just a shell
		cmd = exec.Command("tmux", "new-session", "-d", "-s", sessionName, "-c", path)
	}

	// Run and wait for session to be created
	return cmd.Run()
}

const gcoolTmuxConfigMarker = "# === GCOOL_TMUX_CONFIG_START_DO_NOT_MODIFY_THIS_LINE ==="
const gcoolTmuxConfigEnd = "# === GCOOL_TMUX_CONFIG_END_DO_NOT_MODIFY_THIS_LINE ==="

const gcoolTmuxConfig = `
# === GCOOL_TMUX_CONFIG_START_DO_NOT_MODIFY_THIS_LINE ===
# gcool opinionated tmux configuration
# WARNING: Do not modify the marker lines above/below - they are used for automatic updates
# You can safely delete this entire section if you no longer want these settings

# Enable mouse support for scrolling
set -g mouse on

# Enable mouse scrolling in copy mode
bind -n WheelUpPane if-shell -F -t = "#{mouse_any_flag}" "send-keys -M" "if -Ft= '#{pane_in_mode}' 'send-keys -M' 'copy-mode -e; send-keys -M'"

# Make scrolling work like in normal terminal
set -g terminal-overrides 'xterm*:smcup@:rmcup@'

# Better scrollback buffer (10000 lines)
set -g history-limit 10000

# Enable focus events (useful for vim/neovim)
set -g focus-events on

# Enable 256 colors
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"

# Start window numbering at 1 (easier to switch)
set -g base-index 1
set -g pane-base-index 1

# Renumber windows when one is closed
set -g renumber-windows on

# Ctrl-D to detach
bind-key -n C-d detach-client

# Status bar styling (minimal)
set -g status-style bg=default,fg=white
set -g status-left-length 40
set -g status-right-length 60
set -g status-left "#[fg=green]gcool:#[fg=cyan]#S "
set -g status-right "#[fg=yellow]%H:%M #[fg=white]%d-%b-%y"

# Pane border colors
set -g pane-border-style fg=colour238
set -g pane-active-border-style fg=colour33

# Message styling
set -g message-style bg=colour33,fg=black,bold
# === GCOOL_TMUX_CONFIG_END_DO_NOT_MODIFY_THIS_LINE ===
`

// HasGcoolTmuxConfig checks if ~/.tmux.conf contains gcool config
func (m *Manager) HasGcoolTmuxConfig() (bool, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return false, err
	}

	tmuxConfPath := filepath.Join(homeDir, ".tmux.conf")
	content, err := os.ReadFile(tmuxConfPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}

	return strings.Contains(string(content), gcoolTmuxConfigMarker), nil
}

// AddGcoolTmuxConfig appends or updates gcool config in ~/.tmux.conf
func (m *Manager) AddGcoolTmuxConfig() error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	tmuxConfPath := filepath.Join(homeDir, ".tmux.conf")

	// Check if config already exists
	hasConfig, err := m.HasGcoolTmuxConfig()
	if err != nil {
		return err
	}

	if hasConfig {
		// Update existing config by removing old and appending new
		if err := m.RemoveGcoolTmuxConfig(); err != nil {
			return fmt.Errorf("failed to update config (remove old): %w", err)
		}
	}

	// Append config
	f, err := os.OpenFile(tmuxConfPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.WriteString(gcoolTmuxConfig); err != nil {
		return err
	}

	return nil
}

// RemoveGcoolTmuxConfig removes gcool config from ~/.tmux.conf
func (m *Manager) RemoveGcoolTmuxConfig() error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	tmuxConfPath := filepath.Join(homeDir, ".tmux.conf")

	content, err := os.ReadFile(tmuxConfPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("~/.tmux.conf does not exist")
		}
		return err
	}

	contentStr := string(content)

	// Find and remove the gcool config section
	startIdx := strings.Index(contentStr, gcoolTmuxConfigMarker)
	if startIdx == -1 {
		return fmt.Errorf("gcool tmux config not found in ~/.tmux.conf")
	}

	endIdx := strings.Index(contentStr, gcoolTmuxConfigEnd)
	if endIdx == -1 {
		return fmt.Errorf("gcool tmux config end marker not found in ~/.tmux.conf")
	}

	// Remove the section (including the end marker line)
	endIdx += len(gcoolTmuxConfigEnd)
	// Also remove trailing newline if present
	if endIdx < len(contentStr) && contentStr[endIdx] == '\n' {
		endIdx++
	}

	newContent := contentStr[:startIdx] + contentStr[endIdx:]

	// Write back
	if err := os.WriteFile(tmuxConfPath, []byte(newContent), 0644); err != nil {
		return err
	}

	return nil
}

// Attach attaches to an existing tmux session
func (m *Manager) Attach(sessionName string) error {
	cmd := exec.Command("tmux", "attach-session", "-t", sessionName)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Run and wait for the command to complete (user detaches from tmux)
	return cmd.Run()
}

// NewWindowAndAttach creates a new window in existing session and attaches to it
func (m *Manager) NewWindowAndAttach(sessionName, path string) error {
	// Create a new window in the existing session with the specified path
	// and attach to the session
	cmd := exec.Command("tmux", "new-window", "-t", sessionName, "-c", path)
	if err := cmd.Run(); err != nil {
		return err
	}

	// Now attach to the session
	return m.Attach(sessionName)
}

// List returns all gcool tmux sessions
func (m *Manager) List() ([]Session, error) {
	// List all sessions with format: name:windows:attached
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_attached}")
	output, err := cmd.Output()
	if err != nil {
		// No sessions exist
		return []Session{}, nil
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	var sessions []Session

	for _, line := range lines {
		if !strings.HasPrefix(line, sessionPrefix) {
			continue
		}

		parts := strings.Split(line, ":")
		if len(parts) < 3 {
			continue
		}

		name := parts[0]
		branch := strings.TrimPrefix(name, sessionPrefix)
		active := parts[2] == "1"

		// Parse window count
		windows := 1
		fmt.Sscanf(parts[1], "%d", &windows)

		sessions = append(sessions, Session{
			Name:    name,
			Branch:  branch,
			Active:  active,
			Windows: windows,
		})
	}

	return sessions, nil
}

// Kill terminates a tmux session
func (m *Manager) Kill(sessionName string) error {
	cmd := exec.Command("tmux", "kill-session", "-t", sessionName)
	return cmd.Run()
}

// RenameSession renames an existing tmux session
// Returns nil if session doesn't exist (no error)
func (m *Manager) RenameSession(oldName, newName string) error {
	// Check if session exists
	if !m.SessionExists(oldName) {
		// Session doesn't exist, nothing to do
		return nil
	}

	cmd := exec.Command("tmux", "rename-session", "-t", oldName, newName)
	return cmd.Run()
}

// IsTmuxAvailable checks if tmux is installed
func (m *Manager) IsTmuxAvailable() bool {
	cmd := exec.Command("tmux", "-V")
	err := cmd.Run()
	return err == nil
}
