package version

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"

	gover "github.com/hashicorp/go-version"
	"github.com/coollabsio/gcool/config"
)

const (
	CliVersion   = "0.1.0"
	CheckInterval = 10 * time.Minute
	repoOwner    = "coollabsio"
	repoName     = "gcool"
)

// GitRef represents a git reference from GitHub API
type GitRef struct {
	Ref string `json:"ref"`
	URL string `json:"url"`
}

// CheckLatestVersionOfCli checks if there's a newer version available
func CheckLatestVersionOfCli(debug bool) {
	configManager, err := config.NewManager()
	if err != nil {
		if debug {
			fmt.Printf("Debug: failed to load config: %v\n", err)
		}
		return
	}

	// Check if we should skip the check based on last check time
	lastCheckStr := configManager.GetLastUpdateCheckTime()
	if lastCheckStr != "" {
		lastCheck, err := time.Parse(time.RFC3339, lastCheckStr)
		if err == nil {
			if time.Since(lastCheck) < CheckInterval {
				if debug {
					fmt.Printf("Debug: skipping version check (last checked %v ago)\n", time.Since(lastCheck))
				}
				return
			}
		}
	}

	// Update last check time
	now := time.Now().UTC()
	if err := configManager.SetLastUpdateCheckTime(now.Format(time.RFC3339)); err != nil {
		if debug {
			fmt.Printf("Debug: failed to save last check time: %v\n", err)
		}
	}

	// Fetch latest version from GitHub
	latestVersion, err := fetchLatestVersion(context.Background())
	if err != nil {
		if debug {
			fmt.Printf("Debug: failed to fetch latest version: %v\n", err)
		}
		return
	}

	// Compare versions
	current, err := gover.NewVersion(CliVersion)
	if err != nil {
		if debug {
			fmt.Printf("Debug: failed to parse current version: %v\n", err)
		}
		return
	}

	if latestVersion.GreaterThan(current) {
		fmt.Printf("\nThere is a new version of gcool available: %s (you have %s)\n", latestVersion.String(), CliVersion)
		fmt.Printf("Please update with 'gcool update'\n\n")
	}
}

// fetchLatestVersion fetches the latest version from GitHub API
func fetchLatestVersion(ctx context.Context) (*gover.Version, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/git/refs/tags", repoOwner, repoName)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github api returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var refs []GitRef
	if err := json.Unmarshal(body, &refs); err != nil {
		return nil, err
	}

	if len(refs) == 0 {
		return nil, fmt.Errorf("no tags found")
	}

	// Parse all versions and find the latest
	var versions []*gover.Version
	for _, ref := range refs {
		// Extract version from ref (e.g., "refs/tags/v0.1.0" -> "0.1.0")
		tagName := ref.Ref[10:] // Skip "refs/tags/"

		// Handle v-prefixed versions
		if len(tagName) > 0 && tagName[0] == 'v' {
			tagName = tagName[1:]
		}

		v, err := gover.NewVersion(tagName)
		if err != nil {
			// Skip invalid versions
			continue
		}
		versions = append(versions, v)
	}

	if len(versions) == 0 {
		return nil, fmt.Errorf("no valid versions found")
	}

	// Sort and get the latest
	sort.Sort(sort.Reverse(gover.Collection(versions)))
	return versions[0], nil
}
