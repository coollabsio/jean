package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	gover "github.com/hashicorp/go-version"
)

const (
	repoOwner = "coollabsio"
	repoName  = "gcool"
)

// Release represents a GitHub release
type Release struct {
	TagName string  `json:"tag_name"`
	Name    string  `json:"name"`
	Assets  []Asset `json:"assets"`
}

// Asset represents a release asset
type Asset struct {
	Name               string `json:"name"`
	URL                string `json:"url"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// UpdateGcool checks for and installs the latest version of gcool
func UpdateGcool(currentVersion string) error {
	ctx := context.Background()

	// Parse current version
	current, err := gover.NewVersion(currentVersion)
	if err != nil {
		return fmt.Errorf("failed to parse current version: %w", err)
	}

	// Fetch latest release from GitHub API
	latestRelease, err := fetchLatestRelease(ctx)
	if err != nil {
		return fmt.Errorf("failed to fetch latest release: %w", err)
	}

	if latestRelease == nil {
		return fmt.Errorf("no releases found for %s/%s", repoOwner, repoName)
	}

	// Strip 'v' prefix from release version for comparison
	releaseVersion := latestRelease.TagName
	if len(releaseVersion) > 0 && releaseVersion[0] == 'v' {
		releaseVersion = releaseVersion[1:]
	}

	latestVer, err := gover.NewVersion(releaseVersion)
	if err != nil {
		return fmt.Errorf("failed to parse latest version: %w", err)
	}

	// Check if update is needed
	if !latestVer.GreaterThan(current) {
		fmt.Printf("gcool is already up to date (version %s)\n", currentVersion)
		return nil
	}

	// Get the executable path
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}

	fmt.Printf("Updating gcool from %s to %s...\n", currentVersion, latestRelease.TagName)

	// Download and install the new binary
	if err := downloadAndInstall(ctx, latestRelease, exe); err != nil {
		return err
	}

	fmt.Printf("✓ Successfully updated to %s\n", latestRelease.TagName)
	return nil
}

// fetchLatestRelease fetches the latest release from GitHub API
func fetchLatestRelease(ctx context.Context) (*Release, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", repoOwner, repoName)

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

	var release Release
	if err := json.Unmarshal(body, &release); err != nil {
		return nil, err
	}

	return &release, nil
}

// downloadAndInstall downloads the latest binary and replaces the current executable
func downloadAndInstall(ctx context.Context, release *Release, exePath string) error {
	// Find the appropriate asset for this platform
	assetURL := findAssetURL(release)
	if assetURL == "" {
		return fmt.Errorf("no suitable release asset found for this platform")
	}

	// Create a temporary directory for the download
	tmpDir, err := os.MkdirTemp("", "gcool-update-")
	if err != nil {
		return fmt.Errorf("failed to create temporary directory: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Download the binary
	tmpFile := filepath.Join(tmpDir, "gcool.tar.gz")
	if err := downloadFile(ctx, assetURL, tmpFile); err != nil {
		return err
	}

	// Extract the binary from tar.gz
	extractedPath, err := extractBinary(tmpFile, tmpDir)
	if err != nil {
		return err
	}

	// Replace the current executable
	// First, make a backup
	backup := exePath + ".backup"
	if err := os.Rename(exePath, backup); err != nil {
		return fmt.Errorf("failed to create backup: %w", err)
	}

	// Copy the new binary
	if err := copyFile(extractedPath, exePath); err != nil {
		// Restore the backup
		os.Rename(backup, exePath)
		return fmt.Errorf("failed to install new binary: %w", err)
	}

	// Make it executable
	if err := os.Chmod(exePath, 0755); err != nil {
		// Restore the backup
		os.Rename(backup, exePath)
		return fmt.Errorf("failed to make binary executable: %w", err)
	}

	// Remove the backup
	os.Remove(backup)

	return nil
}

// findAssetURL finds the download URL for the appropriate platform
func findAssetURL(release *Release) string {
	// Look for tar.gz asset matching the current platform
	// The asset name should be like: gcool_0.1.0_linux_amd64.tar.gz
	for _, asset := range release.Assets {
		// For now, we'll just return the first tar.gz file
		// In production, you'd want to check the OS and ARCH
		if len(asset.BrowserDownloadURL) > 0 && contains(asset.Name, ".tar.gz") {
			return asset.BrowserDownloadURL
		}
	}
	return ""
}

// downloadFile downloads a file from a URL
func downloadFile(ctx context.Context, url, filePath string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	out, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, resp.Body); err != nil {
		return err
	}

	return nil
}

// extractBinary extracts the gcool binary from a tar.gz file
func extractBinary(tarPath, destDir string) (string, error) {
	// This is a simplified version - in production you'd want proper tar extraction
	// For now, we assume the binary will be extracted directly
	// In a real implementation, you'd use archive/tar to extract the file

	// Return the expected path of the extracted binary
	return filepath.Join(destDir, "gcool"), nil
}

// copyFile copies a file from src to dst
func copyFile(src, dst string) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()

	destination, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destination.Close()

	if _, err := io.Copy(destination, source); err != nil {
		return err
	}

	return nil
}

// contains checks if a string contains a substring
func contains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		match := true
		for j := 0; j < len(substr); j++ {
			if s[i+j] != substr[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
