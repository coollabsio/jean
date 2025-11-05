package git

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/coollabsio/gcool/config"
)

// Worktree represents a Git worktree
type Worktree struct {
	Path              string
	Branch            string
	Commit            string
	IsCurrent         bool
	BehindCount       int              // Commits behind base branch
	AheadCount        int              // Commits ahead of base branch
	IsOutdated        bool             // Convenience flag: true if behind > 0
	HasUncommitted    bool             // Whether the worktree has uncommitted changes
	PRs               interface{}      // []config.PRInfo - Pull requests for this branch (loaded from config)
	LastModified      time.Time        // Last modification time of the worktree directory
	ClaudeSessionName string           // Sanitized tmux session name for Claude (e.g., "gcool-feature-add-status")
}

// Manager handles Git worktree operations
type Manager struct {
	repoPath string
}

// NewManager creates a new worktree manager
func NewManager(repoPath string) *Manager {
	return &Manager{repoPath: repoPath}
}

// List returns all worktrees in the repository with status relative to the base branch
func (m *Manager) List(baseBranch string) ([]Worktree, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "worktree", "list", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to list worktrees: %w", err)
	}

	return m.parseWorktrees(string(output), baseBranch)
}

// ListLightweight returns all worktrees without expensive status checks (for quick refreshes)
func (m *Manager) ListLightweight() ([]Worktree, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "worktree", "list", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to list worktrees: %w", err)
	}

	// Pass empty baseBranch to skip status calculations
	return m.parseWorktrees(string(output), "")
}

// parseWorktrees parses the output of 'git worktree list --porcelain' and calculates branch status
func (m *Manager) parseWorktrees(output string, baseBranch string) ([]Worktree, error) {
	var worktrees []Worktree
	var current Worktree

	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		if line == "" {
			if current.Path != "" {
				// Populate LastModified time before adding to list
				if modTime, err := m.getWorktreeModTime(current.Path); err == nil {
					current.LastModified = modTime
				}
				worktrees = append(worktrees, current)
				current = Worktree{}
			}
			continue
		}

		parts := strings.SplitN(line, " ", 2)
		if len(parts) < 2 {
			continue
		}

		key := parts[0]
		value := parts[1]

		switch key {
		case "worktree":
			current.Path = value
		case "HEAD":
			current.Commit = value
		case "branch":
			// Remove "refs/heads/" prefix
			current.Branch = strings.TrimPrefix(value, "refs/heads/")
		case "detached":
			current.Branch = fmt.Sprintf("(detached at %s)", current.Commit[:7])
		}
	}

	// Add the last worktree if exists
	if current.Path != "" {
		// Populate LastModified time before adding to list
		if modTime, err := m.getWorktreeModTime(current.Path); err == nil {
			current.LastModified = modTime
		}
		worktrees = append(worktrees, current)
	}

	// Mark current worktree and check for uncommitted changes
	currentPath, err := m.getCurrentPath()
	if err == nil {
		for i := range worktrees {
			if worktrees[i].Path == currentPath {
				worktrees[i].IsCurrent = true
			}
		}
	}

	// Check for uncommitted changes in each worktree
	for i := range worktrees {
		hasUncommitted, err := m.HasUncommittedChanges(worktrees[i].Path)
		if err == nil {
			worktrees[i].HasUncommitted = hasUncommitted
		}
	}

	// Calculate branch status relative to base branch
	if baseBranch != "" {
		for i := range worktrees {
			// Skip detached HEAD and main repo worktrees
			if strings.HasPrefix(worktrees[i].Branch, "(detached") {
				continue
			}

			// Skip if we can't get branch status (base branch might not exist locally)
			aheadCount, behindCount, err := m.GetBranchStatus(worktrees[i].Path, worktrees[i].Branch, baseBranch)
			if err != nil {
				// Silent skip - base branch might not exist locally or there might be other issues
				continue
			}

			worktrees[i].AheadCount = aheadCount
			worktrees[i].BehindCount = behindCount
			worktrees[i].IsOutdated = behindCount > 0
		}
	}

	return worktrees, nil
}

// getWorktreeModTime returns the modification time of a worktree directory
func (m *Manager) getWorktreeModTime(path string) (time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

// GetCurrentBranch returns the name of the current branch
func (m *Manager) GetCurrentBranch() (string, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "branch", "--show-current")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get current branch: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

// GetDefaultBranch tries to determine the default branch (main, master, etc.)
func (m *Manager) GetDefaultBranch() (string, error) {
	// First try to get the default branch from remote
	cmd := exec.Command("git", "-C", m.repoPath, "symbolic-ref", "refs/remotes/origin/HEAD")
	output, err := cmd.Output()
	if err == nil {
		// Extract branch name from refs/remotes/origin/HEAD -> refs/remotes/origin/main
		branch := strings.TrimSpace(string(output))
		branch = strings.TrimPrefix(branch, "refs/remotes/origin/")
		if branch != "" {
			return branch, nil
		}
	}

	// Fallback: check if main or master exists locally
	for _, branch := range []string{"main", "master"} {
		cmd := exec.Command("git", "-C", m.repoPath, "rev-parse", "--verify", branch)
		if err := cmd.Run(); err == nil {
			return branch, nil
		}
	}

	// Last resort: get the first branch
	cmd = exec.Command("git", "-C", m.repoPath, "branch", "--format=%(refname:short)")
	output, err = cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get any branch: %w", err)
	}

	branches := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(branches) > 0 && branches[0] != "" {
		return branches[0], nil
	}

	return "", fmt.Errorf("no branches found in repository")
}

// getCurrentPath returns the current worktree path
func (m *Manager) getCurrentPath() (string, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "rev-parse", "--show-toplevel")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

// sanitizeBranchForPath converts a branch name to a safe directory name
// Strips origin/ prefix and replaces slashes with hyphens
func sanitizeBranchForPath(branch string) string {
	// Strip origin/ prefix for remote tracking branches
	path := strings.TrimPrefix(branch, "origin/")
	// Replace remaining slashes with hyphens to avoid nested directories
	path = strings.ReplaceAll(path, "/", "-")
	return path
}

// getLocalBranchName extracts the local branch name from a branch reference
// For remote branches like "origin/next", returns "next"
// For local branches, returns the branch as-is
func getLocalBranchName(branch string) string {
	return strings.TrimPrefix(branch, "origin/")
}

// isRemoteBranch checks if a branch reference is a remote tracking branch
func isRemoteBranch(branch string) bool {
	return strings.HasPrefix(branch, "origin/")
}

// branchExists checks if a local branch exists in the repository
func (m *Manager) branchExists(branch string) bool {
	cmd := exec.Command("git", "-C", m.repoPath, "rev-parse", "--verify", branch)
	return cmd.Run() == nil
}

// Create creates a new worktree
func (m *Manager) Create(path, branch string, newBranch bool, baseBranch string) error {
	// Validate base branch exists if specified
	if newBranch && baseBranch != "" {
		cmd := exec.Command("git", "-C", m.repoPath, "rev-parse", "--verify", baseBranch)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("base branch '%s' does not exist. Use 'c' to change the base branch", baseBranch)
		}
	}

	args := []string{"-C", m.repoPath, "worktree", "add"}
	workspacePath := path // May be adjusted below

	if newBranch {
		args = append(args, "-b", branch)
	} else if isRemoteBranch(branch) {
		// For remote branches, check if local branch already exists
		localBranch := getLocalBranchName(branch)
		if m.branchExists(localBranch) {
			// Local branch already exists, generate a unique name
			// e.g., "next" -> "next-happy-panda-42"
			uniqueSuffix := generateRandomName()
			localBranch = fmt.Sprintf("%s-%s", localBranch, uniqueSuffix)
			// Also update the workspace path to be unique
			workspacePath = filepath.Join(filepath.Dir(path), localBranch)
		}
		// Use --track flag to create local tracking branch (either new or unique name)
		args = append(args, "--track", "-b", localBranch)
	}

	args = append(args, workspacePath)

	if !newBranch {
		args = append(args, branch)
	} else if baseBranch != "" {
		// When creating new branch, specify the base branch to start from
		args = append(args, baseBranch)
	}

	cmd := exec.Command("git", args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to create worktree: %s", string(output))
	}

	// Execute setup script if configured (non-blocking - errors are returned but don't prevent worktree usage)
	if err := m.executeSetupScript(workspacePath); err != nil {
		return fmt.Errorf("setup script failed: %w", err)
	}

	return nil
}

// executeSetupScript runs the onWorktreeCreate script from gcool.json if configured
// Returns error if script execution fails, nil if no script configured or script succeeds
func (m *Manager) executeSetupScript(workspacePath string) error {
	// Load script config from repository root
	repoRoot, err := m.GetRepoRoot()
	if err != nil {
		return fmt.Errorf("failed to get repo root: %w", err)
	}

	scriptConfig, err := config.LoadScripts(repoRoot)
	if err != nil {
		return fmt.Errorf("failed to load gcool.json: %w", err)
	}

	// Get the onWorktreeCreate script
	script := scriptConfig.GetScript("onWorktreeCreate")
	if script == "" {
		// No setup script configured, skip
		return nil
	}

	// Set environment variables for the script
	cmd := exec.Command("sh", "-c", script)
	cmd.Dir = workspacePath // Run script in the worktree directory
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("GCOOL_WORKSPACE_PATH=%s", workspacePath),
		fmt.Sprintf("GCOOL_ROOT_PATH=%s", repoRoot),
	)

	// Capture both stdout and stderr for error reporting
	output, err := cmd.CombinedOutput()
	if err != nil {
		// Script failed - return error with output for user debugging
		return fmt.Errorf("%s\n\nScript output:\n%s", err.Error(), string(output))
	}

	return nil
}

// Remove removes a worktree
func (m *Manager) Remove(path string, force bool) error {
	args := []string{"-C", m.repoPath, "worktree", "remove"}

	if force {
		args = append(args, "--force")
	}

	args = append(args, path)

	cmd := exec.Command("git", args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to remove worktree: %s", string(output))
	}

	return nil
}

// MoveWorktree moves a worktree to a new location using git worktree move
// This is used to rename the worktree directory when a branch is renamed
func (m *Manager) MoveWorktree(oldPath, newPath string) error {
	cmd := exec.Command("git", "-C", m.repoPath, "worktree", "move", oldPath, newPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to move worktree: %s", string(output))
	}
	return nil
}

// EnsureWorktreeExists checks if the worktree directory exists and recreates it if missing
// This is useful when a worktree has been deleted externally but git still tracks it
func (m *Manager) EnsureWorktreeExists(path, branch string) error {
	// Check if the directory exists
	if _, err := os.Stat(path); err == nil {
		// Directory exists, nothing to do
		return nil
	}

	// Directory doesn't exist, recreate it
	args := []string{"-C", m.repoPath, "worktree", "add", path, branch}
	cmd := exec.Command("git", args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to recreate worktree: %s", string(output))
	}

	// Execute setup script if configured (non-blocking)
	if err := m.executeSetupScript(path); err != nil {
		// Log the error but don't fail - worktree is still usable
		fmt.Fprintf(os.Stderr, "Warning: setup script failed during worktree recreation: %v\n", err)
	}

	return nil
}

// RenameBranch renames the current branch
func (m *Manager) RenameBranch(oldName, newName string) error {
	cmd := exec.Command("git", "-C", m.repoPath, "branch", "-m", oldName, newName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to rename branch: %s", string(output))
	}
	return nil
}

// RenameBranchInWorktree renames a branch in a specific worktree
func (m *Manager) RenameBranchInWorktree(worktreePath, oldName, newName string) error {
	cmd := exec.Command("git", "-C", worktreePath, "branch", "-m", oldName, newName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to rename branch: %s", string(output))
	}
	return nil
}

// BranchExists checks if a branch exists locally in the worktree at the given path
func (m *Manager) BranchExists(worktreePath, branchName string) (bool, error) {
	cmd := exec.Command("git", "-C", worktreePath, "rev-parse", "--verify", branchName)
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	// Branch doesn't exist
	return false, nil
}

// SanitizeBranchName sanitizes a branch name by:
// - Trimming leading/trailing whitespace
// - Converting spaces to hyphens
// - Removing invalid git branch characters
// - Collapsing multiple consecutive hyphens
// - Removing leading/trailing hyphens
func SanitizeBranchName(name string) string {
	// Trim leading/trailing whitespace
	name = strings.TrimSpace(name)

	// Convert spaces to hyphens
	name = strings.ReplaceAll(name, " ", "-")

	// Remove invalid git branch characters: ~ ^ : ? * [ \ and non-ASCII control chars
	var result strings.Builder
	for i := 0; i < len(name); i++ {
		c := name[i]
		// Allow alphanumeric, hyphens, underscores, dots, forward slashes
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '/' {
			result.WriteByte(c)
		}
	}
	name = result.String()

	// Collapse multiple consecutive hyphens into single hyphen
	for strings.Contains(name, "--") {
		name = strings.ReplaceAll(name, "--", "-")
	}

	// Remove leading/trailing hyphens
	name = strings.Trim(name, "-")

	return name
}

// CheckoutBranch checks out a branch in the main repository
func (m *Manager) CheckoutBranch(branch string) error {
	cmd := exec.Command("git", "-C", m.repoPath, "checkout", branch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to checkout branch: %s", string(output))
	}
	return nil
}

// ListBranches returns all branches in the repository
func (m *Manager) ListBranches() ([]string, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "branch", "-a", "--format=%(refname:short)")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to list branches: %w", err)
	}

	branches := strings.Split(strings.TrimSpace(string(output)), "\n")

	// Filter out current branch marker (origin/HEAD)
	var filtered []string
	for _, b := range branches {
		b = strings.TrimSpace(b)
		if b != "" && !strings.HasPrefix(b, "origin/HEAD") {
			filtered = append(filtered, b)
		}
	}

	return filtered, nil
}

// GetRepoRoot returns the root path of the repository
func (m *Manager) GetRepoRoot() (string, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "rev-parse", "--show-toplevel")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("not a git repository or git is not installed")
	}
	return strings.TrimSpace(string(output)), nil
}

// GetDefaultPath returns a default path for a new worktree in .workspaces directory
func (m *Manager) GetDefaultPath(branch string) (string, error) {
	root, err := m.GetRepoRoot()
	if err != nil {
		return "", err
	}

	// Use .workspaces directory inside repo root
	workspacesDir := filepath.Join(root, ".workspaces")

	// Sanitize branch name to create safe directory name
	sanitized := sanitizeBranchForPath(branch)
	return filepath.Join(workspacesDir, sanitized), nil
}

// GetWorkspacesDir returns the .workspaces directory path
func (m *Manager) GetWorkspacesDir() (string, error) {
	root, err := m.GetRepoRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, ".workspaces"), nil
}

// EnsureWorkspacesDir creates the .workspaces directory if it doesn't exist
func (m *Manager) EnsureWorkspacesDir() error {
	dir, err := m.GetWorkspacesDir()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create .workspaces directory: %w", err)
	}

	return nil
}

// Random name generator - generates fun, memorable names
var (
	adjectives = []string{
		"happy", "swift", "bright", "calm", "brave", "clever", "gentle", "quick",
		"proud", "wise", "noble", "bold", "cool", "keen", "warm", "kind",
		"fine", "grand", "pure", "true", "vital", "witty", "zesty", "apt",
	}

	nouns = []string{
		"panda", "fox", "wolf", "bear", "lion", "tiger", "eagle", "falcon",
		"hawk", "raven", "owl", "dragon", "phoenix", "wizard", "knight", "warrior",
		"ninja", "samurai", "pirate", "viking", "spartan", "ranger", "hunter", "scout",
	}
)

// GenerateRandomName creates a random name like "happy-panda-42"
func (m *Manager) GenerateRandomName() (string, error) {
	return generateRandomName(), nil
}

// generateRandomName creates a random name like "happy-panda-42"
func generateRandomName() string {
	adjective := adjectives[randomInt(len(adjectives))]
	noun := nouns[randomInt(len(nouns))]
	number := randomInt(100)

	return fmt.Sprintf("%s-%s-%d", adjective, noun, number)
}

// randomInt returns a random integer between 0 and max (exclusive)
func randomInt(max int) int {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		// Fallback to a simple number if crypto/rand fails
		return 0
	}
	return int(n.Int64())
}

// IsRandomBranchName checks if a branch name matches the random naming pattern (adjective-noun-number)
func (m *Manager) IsRandomBranchName(branchName string) bool {
	parts := strings.Split(branchName, "-")
	if len(parts) != 3 {
		return false
	}

	// Check if part 1 is in adjectives list
	for _, adj := range adjectives {
		if parts[0] == adj {
			// Check if part 2 is in nouns list
			for _, noun := range nouns {
				if parts[1] == noun {
					// Check if part 3 is a valid number
					_, err := fmt.Sscanf(parts[2], "%d", new(int))
					return err == nil
				}
			}
			return false
		}
	}
	return false
}

// Push pushes commits from a branch to remote
func (m *Manager) Push(worktreePath, branch string) error {
	// Debug logging: capture git config for troubleshooting
	debugLog := "=== GCool Git Push Debug Log ===\n"
	debugLog += fmt.Sprintf("Timestamp: %s\n", time.Now().String())
	debugLog += fmt.Sprintf("Worktree Path: %s\n", worktreePath)
	debugLog += fmt.Sprintf("Branch: %s\n", branch)
	debugLog += fmt.Sprintf("Working Directory: %s\n", m.repoPath)

	// Log ALL environment variables
	debugLog += "\n--- All Environment Variables ---\n"
	for _, env := range os.Environ() {
		debugLog += env + "\n"
	}

	// Log git config
	debugLog += "\n--- Git Config (in worktree) ---\n"
	configCmd := exec.Command("git", "-C", worktreePath, "config", "--list")
	if configOutput, err := configCmd.CombinedOutput(); err == nil {
		debugLog += string(configOutput)
	} else {
		debugLog += fmt.Sprintf("Error getting config: %v\n", err)
	}

	// Log global git config
	debugLog += "\n--- Git Config (global) ---\n"
	globalConfigCmd := exec.Command("git", "config", "--global", "--list")
	if globalOutput, err := globalConfigCmd.CombinedOutput(); err == nil {
		debugLog += string(globalOutput)
	} else {
		debugLog += fmt.Sprintf("Error getting global config: %v\n", err)
	}

	// Write debug log to file
	if err := os.WriteFile("/tmp/gcool-git-debug.log", []byte(debugLog), 0644); err != nil {
		// Log write error but continue
		fmt.Fprintf(os.Stderr, "Warning: could not write debug log: %v\n", err)
	}

	// First check if remote exists
	cmd := exec.Command("git", "-C", worktreePath, "remote", "get-url", "origin")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("no remote 'origin' configured")
	}

	// Push with --set-upstream to create remote branch if it doesn't exist
	cmd = exec.Command("git", "-C", worktreePath, "push", "-u", "origin", branch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to push: %s", string(output))
	}

	return nil
}

// RemoteBranchExists checks if a branch exists on the remote
func (m *Manager) RemoteBranchExists(worktreePath, branch string) (bool, error) {
	cmd := exec.Command("git", "-C", worktreePath, "rev-parse", "--verify", fmt.Sprintf("origin/%s", branch))
	err := cmd.Run()
	if err != nil {
		// Check if it's an actual error or just branch not found
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 128 {
			return false, nil
		}
		return false, fmt.Errorf("failed to check remote branch: %w", err)
	}
	return true, nil
}

// DeleteRemoteBranch deletes a branch from the remote repository
func (m *Manager) DeleteRemoteBranch(worktreePath, branch string) error {
	cmd := exec.Command("git", "-C", worktreePath, "push", "origin", "--delete", branch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to delete remote branch: %s", string(output))
	}
	return nil
}

// HasCommits checks if the current branch has any commits
func (m *Manager) HasCommits(worktreePath string) (bool, error) {
	cmd := exec.Command("git", "-C", worktreePath, "rev-list", "--count", "HEAD")
	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("failed to count commits: %w", err)
	}
	commitCount := strings.TrimSpace(string(output))
	return commitCount != "0", nil
}

// HasUnpushedCommits checks if there are commits that haven't been pushed
func (m *Manager) HasUnpushedCommits(worktreePath, branch string) (bool, error) {
	// First check if remote branch exists
	remoteBranchExists, err := m.RemoteBranchExists(worktreePath, branch)
	if err != nil {
		return false, err
	}

	if !remoteBranchExists {
		// Remote branch doesn't exist, so we have unpushed commits if we have any commits
		return m.HasCommits(worktreePath)
	}

	// Remote branch exists, check if we're ahead
	cmd := exec.Command("git", "-C", worktreePath, "rev-list", "--count", fmt.Sprintf("origin/%s..HEAD", branch))
	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("failed to check unpushed commits: %w", err)
	}

	commitCount := strings.TrimSpace(string(output))
	return commitCount != "0", nil
}

// GetRemoteURL returns the URL of the origin remote
func (m *Manager) GetRemoteURL() (string, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "remote", "get-url", "origin")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get remote URL: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

// IsGitHubRepo checks if the repository is hosted on GitHub
func (m *Manager) IsGitHubRepo() (bool, error) {
	url, err := m.GetRemoteURL()
	if err != nil {
		return false, err
	}

	// Check if URL contains github.com
	return strings.Contains(url, "github.com"), nil
}

// HasUncommittedChanges checks if there are uncommitted changes in a worktree
func (m *Manager) HasUncommittedChanges(worktreePath string) (bool, error) {
	// Check for staged and unstaged changes
	cmd := exec.Command("git", "-C", worktreePath, "status", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("failed to check git status: %w", err)
	}

	// If output is not empty, there are uncommitted changes
	return len(strings.TrimSpace(string(output))) > 0, nil
}

// FetchRemote fetches updates from the remote repository without merging
// Returns nil if remote doesn't exist (graceful skip) or if fetch succeeds
// Returns error only if remote exists but fetch fails
func (m *Manager) FetchRemote() error {
	// Check if 'origin' remote exists
	checkCmd := exec.Command("git", "-C", m.repoPath, "remote", "get-url", "origin")
	checkOutput, err := checkCmd.CombinedOutput()
	checkOutputStr := strings.TrimSpace(string(checkOutput))

	// If remote doesn't exist or check fails, skip fetch gracefully
	if err != nil || checkOutputStr == "" {
		return nil // No remote configured, skip fetch
	}

	// Remote exists, attempt fetch
	cmd := exec.Command("git", "-C", m.repoPath, "fetch", "origin")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to fetch from remote: %s", string(output))
	}
	return nil
}

// GetBranchStatus returns the ahead and behind counts for a branch compared to the base branch
// Returns (aheadCount, behindCount, error)
func (m *Manager) GetBranchStatus(worktreePath, branch, baseBranch string) (int, int, error) {
	if baseBranch == "" {
		return 0, 0, fmt.Errorf("base branch not specified")
	}

	// Check if base branch exists
	cmd := exec.Command("git", "-C", worktreePath, "rev-parse", "--verify", baseBranch)
	if err := cmd.Run(); err != nil {
		return 0, 0, fmt.Errorf("base branch '%s' does not exist", baseBranch)
	}

	// Get ahead count (commits in current branch not in base)
	cmd = exec.Command("git", "-C", worktreePath, "rev-list", "--count", fmt.Sprintf("%s..%s", baseBranch, branch))
	output, err := cmd.Output()
	if err != nil {
		return 0, 0, fmt.Errorf("failed to get ahead count: %w", err)
	}
	aheadCount := 0
	fmt.Sscanf(strings.TrimSpace(string(output)), "%d", &aheadCount)

	// Get behind count (commits in base not in current branch)
	cmd = exec.Command("git", "-C", worktreePath, "rev-list", "--count", fmt.Sprintf("%s..%s", branch, baseBranch))
	output, err = cmd.Output()
	if err != nil {
		return 0, 0, fmt.Errorf("failed to get behind count: %w", err)
	}
	behindCount := 0
	fmt.Sscanf(strings.TrimSpace(string(output)), "%d", &behindCount)

	return aheadCount, behindCount, nil
}

// MergeBranch merges the specified base branch into the current branch in the worktree
func (m *Manager) MergeBranch(worktreePath, baseBranch string) error {
	if baseBranch == "" {
		return fmt.Errorf("base branch not specified")
	}

	// Check if base branch exists
	cmd := exec.Command("git", "-C", worktreePath, "rev-parse", "--verify", baseBranch)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("base branch '%s' does not exist", baseBranch)
	}

	// Perform the merge
	cmd = exec.Command("git", "-C", worktreePath, "merge", baseBranch, "--no-edit")
	output, err := cmd.CombinedOutput()
	if err != nil {
		outputStr := string(output)
		// Check if it's a merge conflict
		if strings.Contains(outputStr, "CONFLICT") || strings.Contains(outputStr, "Automatic merge failed") {
			return fmt.Errorf("merge conflict occurred. Use 'git merge --abort' to abort the merge")
		}
		return fmt.Errorf("failed to merge: %s", outputStr)
	}

	return nil
}

// AbortMerge aborts an in-progress merge and returns to a clean state
func (m *Manager) AbortMerge(worktreePath string) error {
	cmd := exec.Command("git", "-C", worktreePath, "merge", "--abort")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to abort merge: %s", string(output))
	}
	return nil
}

// PullCurrentBranch pulls the current branch from origin
// For repositories without a remote, falls back to no-op
func (m *Manager) PullCurrentBranch(worktreePath, branch string) error {
	// Check if 'origin' remote exists
	checkCmd := exec.Command("git", "-C", worktreePath, "remote", "get-url", "origin")
	checkOutput, err := checkCmd.CombinedOutput()
	checkOutputStr := strings.TrimSpace(string(checkOutput))
	hasRemote := err == nil && checkOutputStr != ""

	// If no remote, skip pull
	if !hasRemote {
		return nil
	}

	cmd := exec.Command("git", "-C", worktreePath, "pull", "origin", branch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		outputStr := string(output)
		// Check if it's a merge conflict
		if strings.Contains(outputStr, "CONFLICT") || strings.Contains(outputStr, "Automatic merge failed") {
			return fmt.Errorf("merge conflict occurred. Use 'git merge --abort' to abort the merge")
		}
		return fmt.Errorf("failed to pull: %s", outputStr)
	}
	return nil
}

// PullBranchInPath pulls a specific branch from origin in the given directory
// For repositories without a remote, falls back to local merge
func (m *Manager) PullBranchInPath(path, branch string) error {
	// Check if 'origin' remote exists
	checkCmd := exec.Command("git", "-C", path, "remote", "get-url", "origin")
	checkOutput, err := checkCmd.CombinedOutput()
	checkOutputStr := strings.TrimSpace(string(checkOutput))
	hasRemote := err == nil && checkOutputStr != ""

	var cmd *exec.Cmd
	if hasRemote {
		// Remote exists, use git pull
		cmd = exec.Command("git", "-C", path, "pull", "origin", branch)
	} else {
		// No remote, use local merge instead
		cmd = exec.Command("git", "-C", path, "merge", branch, "--no-edit")
	}

	output, err := cmd.CombinedOutput()
	if err != nil {
		outputStr := string(output)
		// Check if it's a merge conflict
		if strings.Contains(outputStr, "CONFLICT") || strings.Contains(outputStr, "Automatic merge failed") {
			return fmt.Errorf("merge conflict occurred. Use 'git merge --abort' to abort the merge")
		}
		return fmt.Errorf("failed to pull: %s", outputStr)
	}
	return nil
}

// PullCurrentBranchWithOutput pulls current branch and returns the git output and error
// For repositories without a remote, falls back to local merge
func (m *Manager) PullCurrentBranchWithOutput(worktreePath, branch string) (string, error) {
	// Check if 'origin' remote exists
	checkCmd := exec.Command("git", "-C", worktreePath, "remote", "get-url", "origin")
	checkOutput, err := checkCmd.CombinedOutput()
	checkOutputStr := strings.TrimSpace(string(checkOutput))
	hasRemote := err == nil && checkOutputStr != ""

	var cmd *exec.Cmd
	if hasRemote {
		// Remote exists, use git pull
		cmd = exec.Command("git", "-C", worktreePath, "pull", "origin", branch)
	} else {
		// No remote, use local merge instead
		cmd = exec.Command("git", "-C", worktreePath, "merge", branch, "--no-edit")
	}

	output, err := cmd.CombinedOutput()
	outputStr := string(output)
	if err != nil {
		// Check if it's a merge conflict
		if strings.Contains(outputStr, "CONFLICT") || strings.Contains(outputStr, "Automatic merge failed") {
			return outputStr, fmt.Errorf("merge conflict occurred. Use 'git merge --abort' to abort the merge")
		}
		return outputStr, fmt.Errorf("failed to pull: %s", outputStr)
	}
	return outputStr, nil
}

// PullBranchInPathWithOutput pulls a specific branch and returns the git output and error
// For repositories without a remote, falls back to local merge
func (m *Manager) PullBranchInPathWithOutput(path, branch string) (string, error) {
	// Check if 'origin' remote exists
	checkCmd := exec.Command("git", "-C", path, "remote", "get-url", "origin")
	checkOutput, err := checkCmd.CombinedOutput()
	checkOutputStr := strings.TrimSpace(string(checkOutput))
	hasRemote := err == nil && checkOutputStr != ""

	var cmd *exec.Cmd
	if hasRemote {
		// Remote exists, use git pull
		cmd = exec.Command("git", "-C", path, "pull", "origin", branch)
	} else {
		// No remote, use local merge instead
		cmd = exec.Command("git", "-C", path, "merge", branch, "--no-edit")
	}

	output, err := cmd.CombinedOutput()
	outputStr := string(output)
	if err != nil {
		// Check if it's a merge conflict
		if strings.Contains(outputStr, "CONFLICT") || strings.Contains(outputStr, "Automatic merge failed") {
			return outputStr, fmt.Errorf("merge conflict occurred. Use 'git merge --abort' to abort the merge")
		}
		return outputStr, fmt.Errorf("failed to pull: %s", outputStr)
	}
	return outputStr, nil
}

// ParsePullOutput extracts commit count information from git pull output
// Returns (upToDate, commitsCount)
func (m *Manager) ParsePullOutput(output string) (bool, int) {
	// Check if everything was already up to date
	if strings.Contains(output, "Already up to date") || strings.Contains(output, "Already up-to-date") {
		return true, 0
	}

	// Try to find "X files changed" pattern which indicates commits were pulled
	// Example output: "... (3 commits) ... 5 files changed, 100 insertions(+), 20 deletions(-)"
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		// Look for commit count info in parentheses like "(3 commits)"
		if strings.Contains(line, "commits") {
			// Try to extract number: "* commits", "1 commits", "(3 commits)", etc.
			parts := strings.Fields(line)
			for i, part := range parts {
				if strings.Contains(part, "commit") && i > 0 {
					// Previous part should be the number
					prevPart := strings.Trim(parts[i-1], "(),")
					if count, err := parseCount(prevPart); err == nil && count > 0 {
						return false, count
					}
				}
			}
		}

		// Also look for "# commits"  pattern in fetch output
		if strings.HasPrefix(line, "* [new branch]") || strings.HasPrefix(line, "* [new tag]") {
			continue
		}

		// If we see "Fast-forward" or "merge made", commits were definitely pulled
		if strings.Contains(line, "Fast-forward") || strings.Contains(line, "Merge made") {
			return false, 1 // At least 1 commit
		}
	}

	// If merge happened but we can't count, assume at least 1 commit
	if strings.Contains(output, "merge") || strings.Contains(output, "Merge") {
		return false, 1
	}

	return false, 0
}

// parseCount tries to parse a string as an integer
func parseCount(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty string")
	}

	var num string
	for _, c := range s {
		if c >= '0' && c <= '9' {
			num += string(c)
		}
	}

	if num == "" {
		return 0, fmt.Errorf("no digits found")
	}

	// Convert string to int
	result := 0
	for _, c := range num {
		result = result*10 + int(c-'0')
	}

	return result, nil
}

// CreateCommit stages all changes and creates a commit with the given subject and body
// Returns the commit hash on success or an error
func (m *Manager) CreateCommit(worktreePath, subject, body string) (string, error) {
	if subject == "" {
		return "", fmt.Errorf("commit subject cannot be empty")
	}

	// First, stage all changes (git add -A)
	addCmd := exec.Command("git", "-C", worktreePath, "add", "-A")
	if output, err := addCmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("failed to stage changes: %s", string(output))
	}

	// Build the commit command
	args := []string{"-C", worktreePath, "commit", "-m", subject}

	// Add body if provided
	if body != "" {
		args = append(args, "-m", body)
	}

	commitCmd := exec.Command("git", args...)
	output, err := commitCmd.CombinedOutput()
	outputStr := string(output)

	if err != nil {
		return "", fmt.Errorf("failed to create commit: %s", outputStr)
	}

	// Parse the commit hash from the output
	// Output format: "[branch_name hash] commit subject"
	lines := strings.Split(outputStr, "\n")
	for _, line := range lines {
		// Look for hash in square brackets like "[main abc1234]"
		if strings.Contains(line, "[") && strings.Contains(line, "]") {
			start := strings.Index(line, "[")
			end := strings.Index(line, "]")
			if start < end {
				content := line[start+1 : end]
				parts := strings.Fields(content)
				if len(parts) >= 2 {
					// Last part should be the hash
					return parts[len(parts)-1], nil
				}
			}
		}
	}

	// If we can't parse the hash, run git rev-parse to get it
	hashCmd := exec.Command("git", "-C", worktreePath, "rev-parse", "HEAD")
	hashOutput, err := hashCmd.Output()
	if err == nil {
		return strings.TrimSpace(string(hashOutput)), nil
	}

	// Fallback: return empty string (commit was successful but we couldn't get the hash)
	return "", nil
}

// GetDiff returns the git diff output for uncommitted changes in the worktree
// This is used as context for AI-generated commit messages
// It includes: staged changes, unstaged changes, and untracked file status
func (m *Manager) GetDiff(worktreePath string) (string, error) {
	var result strings.Builder

	// Get staged changes (git add -A staging area)
	stagingCmd := exec.Command("git", "-C", worktreePath, "diff", "--cached")
	stagingOutput, _ := stagingCmd.Output()
	if len(stagingOutput) > 0 {
		result.WriteString("=== STAGED CHANGES ===\n")
		result.Write(stagingOutput)
		result.WriteString("\n")
	}

	// Get unstaged changes (modified tracked files not yet staged)
	unstageCmd := exec.Command("git", "-C", worktreePath, "diff")
	unstageOutput, _ := unstageCmd.Output()
	if len(unstageOutput) > 0 {
		result.WriteString("=== UNSTAGED CHANGES ===\n")
		result.Write(unstageOutput)
		result.WriteString("\n")
	}

	// Get untracked files status
	statusCmd := exec.Command("git", "-C", worktreePath, "status", "--porcelain")
	statusOutput, _ := statusCmd.Output()
	if len(statusOutput) > 0 {
		result.WriteString("=== FILE STATUS ===\n")
		result.Write(statusOutput)
		result.WriteString("\n")
	}

	diff := result.String()
	if diff == "" {
		return "", fmt.Errorf("no changes detected")
	}

	return diff, nil
}

// GetDiffFromBase returns the git diff from the base branch
// This is used as context for AI-generated branch names
func (m *Manager) GetDiffFromBase(worktreePath, baseBranch string) (string, error) {
	if baseBranch == "" {
		return "", fmt.Errorf("base branch not specified")
	}

	// First, ensure the base branch is fetched from remote
	fetchCmd := exec.Command("git", "-C", worktreePath, "fetch", "origin", baseBranch)
	_ = fetchCmd.Run() // Ignore errors, base branch might be local-only

	// Get diff between current branch and base branch
	cmd := exec.Command("git", "-C", worktreePath, "diff", baseBranch)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get diff from base: %w", err)
	}
	return string(output), nil
}

// GetBranchRemoteURL constructs a GitHub URL for a given branch
// Returns the branch URL if the branch exists on remote, otherwise returns the repo URL
func (m *Manager) GetBranchRemoteURL(branchName string) (string, error) {
	isGitHub, err := m.IsGitHubRepo()
	if err != nil {
		return "", err
	}

	if !isGitHub {
		return "", fmt.Errorf("repository is not hosted on GitHub")
	}

	url, err := m.GetRemoteURL()
	if err != nil {
		return "", err
	}

	// Convert SSH URL to HTTPS if needed
	url = convertSSHToHTTPS(url)

	// Check if branch exists on remote
	checkCmd := exec.Command("git", "-C", m.repoPath, "ls-remote", "--heads", "origin", branchName)
	output, err := checkCmd.Output()
	if err == nil && len(strings.TrimSpace(string(output))) > 0 {
		// Branch exists on remote, return branch URL
		return fmt.Sprintf("%s/tree/%s", url, branchName), nil
	}

	// Branch doesn't exist on remote, return repo URL
	return url, nil
}

// GetCurrentUser returns the current git user name
func (m *Manager) GetCurrentUser(worktreePath string) (string, error) {
	cmd := exec.Command("git", "-C", worktreePath, "config", "user.name")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get git user: %w", err)
	}

	return strings.TrimSpace(string(output)), nil
}

// convertSSHToHTTPS converts SSH git URL to HTTPS format
// Example: git@github.com:user/repo.git -> https://github.com/user/repo
func convertSSHToHTTPS(url string) string {
	if strings.HasPrefix(url, "git@") {
		// Convert git@github.com:user/repo.git to https://github.com/user/repo
		url = strings.Replace(url, ":", "/", 1)           // git@github.com/user/repo.git
		url = strings.Replace(url, "git@", "https://", 1) // https://github.com/user/repo.git
	}

	// Remove .git suffix if present
	url = strings.TrimSuffix(url, ".git")
	return url
}

// OpenInBrowser opens a URL in the default web browser
// Works cross-platform: macOS, Linux, and Windows
func OpenInBrowser(url string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		// macOS
		cmd = exec.Command("open", url)
	case "linux":
		// Linux
		cmd = exec.Command("xdg-open", url)
	case "windows":
		// Windows
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		return fmt.Errorf("unsupported operating system: %s", runtime.GOOS)
	}

	// Start the command without waiting for it to complete
	return cmd.Start()
}
