package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const sessionPrefix = "gcool-"

// Session represents a tmux session
type Session struct {
	Name         string
	Branch       string
	Path         string // Working directory of the session
	Active       bool
	Windows      int
	LastActivity time.Time
}

// Manager handles tmux session operations
type Manager struct{}

// NewManager creates a new session manager
func NewManager() *Manager {
	return &Manager{}
}

// SanitizeBranchName sanitizes a branch name for use as a git branch (without prefix)
// This is useful when accepting user input for branch names
func (m *Manager) SanitizeBranchName(branch string) string {
	// Replace invalid characters with hyphens
	reg := regexp.MustCompile(`[^a-zA-Z0-9\-_]`)
	sanitized := reg.ReplaceAllString(branch, "-")

	// Remove consecutive hyphens
	reg = regexp.MustCompile(`-+`)
	sanitized = reg.ReplaceAllString(sanitized, "-")

	// Trim hyphens from start/end
	sanitized = strings.Trim(sanitized, "-")

	return sanitized
}

// SanitizeName sanitizes a branch name for use as a tmux session name
func (m *Manager) SanitizeName(branch string) string {
	// Sanitize the base name first
	sanitized := m.SanitizeBranchName(branch)
	return sessionPrefix + sanitized
}

// SessionExists checks if a tmux session with the given name exists
func (m *Manager) SessionExists(sessionName string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", sessionName)
	err := cmd.Run()
	return err == nil
}

// CreateOrAttach creates a new session or attaches to existing one
// targetWindow specifies which window to attach to: "terminal" (window 0) or "claude" (window 1)
// Always creates both windows when creating a new session
func (m *Manager) CreateOrAttach(path, branch string, autoStartClaude bool, targetWindow string) error {
	sessionName := m.SanitizeName(branch)

	if m.SessionExists(sessionName) {
		// Session exists - ensure target window exists, create if missing
		return m.AttachToWindow(sessionName, path, autoStartClaude, targetWindow)
	}

	// Create new session with both windows
	return m.Create(sessionName, path, autoStartClaude, targetWindow)
}

// Create creates a new tmux session with both windows
// Window 1: terminal (shell) - created automatically by new-session with base-index 1
// Window 2: claude (if autoStartClaude is true)
func (m *Manager) Create(sessionName, path string, autoStartClaude bool, targetWindow string) error {
	// Create detached session with window 1 (terminal) - base-index 1 makes first window = 1
	cmd := exec.Command("tmux", "new-session", "-d", "-s", sessionName, "-c", path, "-n", "terminal")
	if err := cmd.Run(); err != nil {
		return err
	}

	// Create window 2 (claude) if autoStartClaude is true
	if autoStartClaude {
		cmd = exec.Command("tmux", "new-window", "-t", sessionName+":2", "-c", path, "-n", "claude", "claude")
		if err := cmd.Run(); err != nil {
			// Window creation failed, but session exists, so we continue
			// The user can manually create the window later
		}
	}

	// Attach to the target window
	return m.AttachToWindow(sessionName, path, autoStartClaude, targetWindow)
}

// AttachToWindow attaches to a specific window in a session
// Creates the window if it doesn't exist
func (m *Manager) AttachToWindow(sessionName, path string, autoStartClaude bool, targetWindow string) error {
	var windowIndex string
	var windowName string
	var windowCommand string

	if targetWindow == "claude" {
		windowIndex = "2"
		windowName = "claude"
		windowCommand = "claude"
	} else {
		windowIndex = "1"
		windowName = "terminal"
		windowCommand = "" // Will use shell
	}

	// Check if the target window exists
	checkCmd := exec.Command("tmux", "list-windows", "-t", sessionName, "-F", "#{window_index}:#{window_name}")
	output, err := checkCmd.Output()
	if err == nil {
		// Parse the windows to check if target window exists
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		windowExists := false
		for _, line := range lines {
			if strings.Contains(line, windowIndex+":"+windowName) {
				windowExists = true
				break
			}
		}

		// If window doesn't exist, create it
		if !windowExists {
			if targetWindow == "claude" {
				cmd := exec.Command("tmux", "new-window", "-t", sessionName+":"+windowIndex, "-c", path, "-n", windowName, windowCommand)
				cmd.Run() // Ignore errors, window might be created concurrently
			} else {
				cmd := exec.Command("tmux", "new-window", "-t", sessionName+":"+windowIndex, "-c", path, "-n", windowName)
				cmd.Run() // Ignore errors
			}
		}
	}

	// Attach to the target window
	cmd := exec.Command("tmux", "attach-session", "-t", sessionName+":"+windowIndex)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

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

# Enable clickable links (URLs and local filesystem paths)
set -g allow-passthrough on
set -ga terminal-features "*:hyperlinks"

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

# Navigate between windows with Ctrl+arrows
bind-key -n C-Right next-window
bind-key -n C-Left previous-window

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

// List returns all gcool tmux sessions, optionally filtered by repository path
// If repoPath is empty string, returns all gcool sessions
func (m *Manager) List(repoPath string) ([]Session, error) {
	// List all sessions with format: name:windows:attached:activity:path
	// activity is the maximum window_activity timestamp in the session
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}:#{session_path}")
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
		if len(parts) < 5 {
			continue
		}

		name := parts[0]
		sessionPath := parts[4]

		// Filter by repository path if provided
		if repoPath != "" && !strings.HasPrefix(sessionPath, repoPath) {
			continue
		}

		branch := strings.TrimPrefix(name, sessionPrefix)
		active := parts[2] == "1"

		// Parse window count
		windows := 1
		fmt.Sscanf(parts[1], "%d", &windows)

		// Parse activity timestamp (Unix time)
		var lastActivity time.Time
		if activityStr := parts[3]; activityStr != "" {
			if activityUnix, err := strconv.ParseInt(activityStr, 10, 64); err == nil {
				lastActivity = time.Unix(activityUnix, 0)
			}
		}

		sessions = append(sessions, Session{
			Name:         name,
			Branch:       branch,
			Path:         sessionPath,
			Active:       active,
			Windows:      windows,
			LastActivity: lastActivity,
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
