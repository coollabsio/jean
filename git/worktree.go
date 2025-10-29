package git

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Worktree represents a Git worktree
type Worktree struct {
	Path            string
	Branch          string
	Commit          string
	IsCurrent       bool
	BehindCount     int  // Commits behind base branch
	AheadCount      int  // Commits ahead of base branch
	IsOutdated      bool // Convenience flag: true if behind > 0
	HasUncommitted  bool // Whether the worktree has uncommitted changes
}

// Manager handles Git worktree operations
type Manager struct {
	repoPath string
}

// NewManager creates a new worktree manager
func NewManager(repoPath string) *Manager {
	return &Manager{repoPath: repoPath}
}

// List returns all worktrees in the repository
func (m *Manager) List() ([]Worktree, error) {
	cmd := exec.Command("git", "-C", m.repoPath, "worktree", "list", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to list worktrees: %w", err)
	}

	return m.parseWorktrees(string(output))
}

// parseWorktrees parses the output of 'git worktree list --porcelain'
func (m *Manager) parseWorktrees(output string) ([]Worktree, error) {
	var worktrees []Worktree
	var current Worktree

	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		if line == "" {
			if current.Path != "" {
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

	return worktrees, nil
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

// RenameBranch renames the current branch
func (m *Manager) RenameBranch(oldName, newName string) error {
	cmd := exec.Command("git", "-C", m.repoPath, "branch", "-m", oldName, newName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to rename branch: %s", string(output))
	}
	return nil
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

// Push pushes commits from a branch to remote
func (m *Manager) Push(worktreePath, branch string) error {
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
func (m *Manager) FetchRemote() error {
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
// Uses git pull origin <branch>
func (m *Manager) PullCurrentBranch(worktreePath, branch string) error {
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
// Uses git pull origin <branch> in the specified path
func (m *Manager) PullBranchInPath(path, branch string) error {
	cmd := exec.Command("git", "-C", path, "pull", "origin", branch)
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
func (m *Manager) PullCurrentBranchWithOutput(worktreePath, branch string) (string, error) {
	cmd := exec.Command("git", "-C", worktreePath, "pull", "origin", branch)
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
func (m *Manager) PullBranchInPathWithOutput(path, branch string) (string, error) {
	cmd := exec.Command("git", "-C", path, "pull", "origin", branch)
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
