package github

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// Manager handles GitHub operations using gh CLI
type Manager struct{}

// PRInfo holds information about a pull request
type PRInfo struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	HeadRefName string `json:"headRefName"`
	URL         string `json:"url"`
	Status      string `json:"state"` // "OPEN", "MERGED", or "CLOSED"
	Author      struct {
		Login string `json:"login"`
	} `json:"author"`
}

// NewManager creates a new GitHub manager
func NewManager() *Manager {
	return &Manager{}
}

// IsGhInstalled checks if gh CLI is installed
func (m *Manager) IsGhInstalled() bool {
	cmd := exec.Command("gh", "--version")
	return cmd.Run() == nil
}

// IsAuthenticated checks if user is authenticated with gh
func (m *Manager) IsAuthenticated() (bool, error) {
	cmd := exec.Command("gh", "auth", "status")
	output, err := cmd.CombinedOutput()
	if err != nil {
		// If output contains "not logged into", user is not authenticated
		if strings.Contains(string(output), "not logged into") {
			return false, nil
		}
		return false, fmt.Errorf("failed to check auth status: %s", string(output))
	}
	return true, nil
}

// CreatePR creates a pull request (draft or ready for review)
func (m *Manager) CreatePR(worktreePath, branch, baseBranch, title, description string, isDraft bool) (string, error) {
	// Check if gh is installed
	if !m.IsGhInstalled() {
		return "", fmt.Errorf("gh CLI is not installed. Install it from https://cli.github.com")
	}

	// Check if authenticated
	authenticated, err := m.IsAuthenticated()
	if err != nil {
		return "", err
	}
	if !authenticated {
		return "", fmt.Errorf("not authenticated with GitHub. Run 'gh auth login' to authenticate")
	}

	// Create PR with title and description
	args := []string{
		"pr", "create",
		"--base", baseBranch,
		"--head", branch,
		"--title", title,
		"--body", description,
	}

	// Add draft flag if requested
	if isDraft {
		args = append(args, "--draft")
	}

	cmd := exec.Command("gh", args...)
	cmd.Dir = worktreePath
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to create PR: %s", string(output))
	}

	// Extract PR URL from output
	prURL := strings.TrimSpace(string(output))
	return prURL, nil
}

// GetRepoName gets the repository name from gh CLI
func (m *Manager) GetRepoName(worktreePath string) (string, error) {
	cmd := exec.Command("gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
	cmd.Dir = worktreePath
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to get repo name: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

// GetPRStatus gets the current status of a pull request
func (m *Manager) GetPRStatus(prURL string) (string, error) {
	cmd := exec.Command("gh", "pr", "view", prURL, "--json", "state", "--jq", ".state")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to get PR status: %s", string(output))
	}

	// The output will be one of: OPEN, MERGED, CLOSED
	status := strings.ToLower(strings.TrimSpace(string(output)))
	return status, nil
}

// GetPRForBranch gets the PR details for a given branch (if it exists)
func (m *Manager) GetPRForBranch(worktreePath, branch string) (*PRInfo, error) {
	// Search for PR on this branch with full details (including closed/merged)
	cmd := exec.Command("gh", "pr", "list",
		"--head", branch,
		"--state", "all",
		"--json", "number,title,headRefName,url,state,author",
		"--jq", ".[0]")
	cmd.Dir = worktreePath
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("failed to search for PR: %s", string(output))
	}

	outputStr := strings.TrimSpace(string(output))
	if outputStr == "" || outputStr == "null" {
		return nil, nil // No PR found
	}

	// Parse the JSON response
	var prInfo PRInfo
	if err := json.Unmarshal([]byte(outputStr), &prInfo); err != nil {
		return nil, fmt.Errorf("failed to parse PR info: %w", err)
	}

	return &prInfo, nil
}

// UpdatePR updates the title and/or description of an existing PR
func (m *Manager) UpdatePR(worktreePath, prIdentifier, title, description string) error {
	args := []string{"pr", "edit", prIdentifier}

	if title != "" {
		args = append(args, "--title", title)
	}

	if description != "" {
		args = append(args, "--body", description)
	}

	cmd := exec.Command("gh", args...)
	cmd.Dir = worktreePath
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to update PR: %s", string(output))
	}

	return nil
}

// MarkPRReady converts a draft PR to ready for review
func (m *Manager) MarkPRReady(worktreePath, prURL string) error {
	// Check if gh is installed
	if !m.IsGhInstalled() {
		return fmt.Errorf("gh CLI is not installed. Install it from https://cli.github.com")
	}

	// Check if authenticated
	authenticated, err := m.IsAuthenticated()
	if err != nil {
		return err
	}
	if !authenticated {
		return fmt.Errorf("not authenticated with GitHub. Run 'gh auth login' to authenticate")
	}

	// Mark PR as ready (remove draft status)
	cmd := exec.Command("gh", "pr", "ready", prURL)
	cmd.Dir = worktreePath
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to mark PR as ready: %s", string(output))
	}

	return nil
}

// MergePR merges a pull request using the specified merge method
// mergeMethod should be one of: "squash", "merge", "rebase"
func (m *Manager) MergePR(worktreePath, prURL, mergeMethod string) error {
	// Check if gh is installed
	if !m.IsGhInstalled() {
		return fmt.Errorf("gh CLI is not installed. Install it from https://cli.github.com")
	}

	// Check if authenticated
	authenticated, err := m.IsAuthenticated()
	if err != nil {
		return err
	}
	if !authenticated {
		return fmt.Errorf("not authenticated with GitHub. Run 'gh auth login' to authenticate")
	}

	// Validate merge method
	validMethods := map[string]bool{
		"squash":  true,
		"merge":   true,
		"rebase":  true,
	}
	if !validMethods[mergeMethod] {
		return fmt.Errorf("invalid merge method: %s. Must be one of: squash, merge, rebase", mergeMethod)
	}

	// Merge the PR with the specified method
	args := []string{"pr", "merge", prURL, "--" + mergeMethod}
	cmd := exec.Command("gh", args...)
	cmd.Dir = worktreePath
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to merge PR: %s", string(output))
	}

	return nil
}

// ListPRs lists all open pull requests for the repository
func (m *Manager) ListPRs(worktreePath string) ([]PRInfo, error) {
	// Check if gh is installed
	if !m.IsGhInstalled() {
		err := fmt.Errorf("gh CLI is not installed. Install it from https://cli.github.com")
		return nil, err
	}

	// Check if authenticated
	authenticated, err := m.IsAuthenticated()
	if err != nil {
		return nil, err
	}
	if !authenticated {
		err := fmt.Errorf("not authenticated with GitHub. Run 'gh auth login' to authenticate")
		return nil, err
	}

	// List open PRs in JSON format (only 5 latest to avoid cluttering the screen)
	cmd := exec.Command("gh", "pr", "list",
		"--state", "open",
		"--json", "number,title,headRefName,url,author",
		"--limit", "5")
	cmd.Dir = worktreePath
	output, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := fmt.Sprintf("failed to list PRs: %s", string(output))
		return nil, fmt.Errorf(errMsg)
	}

	// Parse JSON response
	var prs []PRInfo
	if err := json.Unmarshal(output, &prs); err != nil {
		errMsg := fmt.Sprintf("failed to parse PR list: %v", err)
		return nil, fmt.Errorf(errMsg)
	}

	return prs, nil
}
