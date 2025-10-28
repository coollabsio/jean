# gcool Updater System

This document describes the updater system implemented for gcool, based on the pattern used in coolify-cli.

## Architecture Overview

The updater system is built on a two-tier approach:

### 1. Passive (Automatic Update Checking)
- Runs automatically on every gcool startup
- Rate-limited to check every 10 minutes
- Non-blocking - doesn't interfere with normal operation
- Only notifies users if an update is available
- Stores last check time in `~/.config/gcool/config.json`

### 2. Active (Manual Update)
- User explicitly runs `gcool update`
- Downloads and installs the latest binary
- Replaces the current binary in-place
- Uses `go-selfupdate` library for robust update mechanism

## Components

### New Files Created

#### 1. `internal/version/version.go`
Handles automatic version checking:
- `CliVersion`: Current version constant (0.1.0)
- `CheckLatestVersionOfCli()`: Main check function
  - Fetches GitHub API for latest release tags
  - Parses semantic versions
  - Compares with current version
  - Displays notification if update available
- `fetchLatestVersion()`: Queries GitHub API and parses releases
- Rate-limiting using config-persisted timestamp

#### 2. `internal/update/update.go`
Handles manual updates:
- `UpdateGcool()`: Main update function
  - Detects latest release from GitHub
  - Validates version compatibility
  - Downloads appropriate binary for platform
  - Replaces current binary
- `getAssetName()`: Generates expected asset name for platform
- `findAsset()`: Locates correct binary in release assets

#### 3. `.goreleaser.yml`
Release automation configuration:
- Builds for: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64
- Creates tar.gz archives with naming convention: `gcool_VERSION_OS_ARCH.tar.gz`
- Generates checksums
- Creates GitHub releases with changelog
- Auto-detects pre-releases

#### 4. `scripts/install.sh`
Installation and bootstrap script:
- Auto-detects OS and architecture
- Supports `--user` flag for ~/.local/bin installation
- Downloads from GitHub releases
- Checks for existing installation
- Prompts for update if already installed
- Handles permissions (sudo for /usr/local/bin)
- Validates PATH configuration

#### 5. `.github/workflows/release.yml`
GitHub Actions workflow for automated releases:
- Triggers on version tags (v*)
- Runs GoReleaser to build all platforms
- Creates GitHub release with all artifacts
- Requires `GITHUB_TOKEN` secret (auto-provided)

### Modified Files

#### 1. `go.mod`
Added dependencies:
```
github.com/creativeprojects/go-selfupdate v1.5.1  // Binary self-update
github.com/hashicorp/go-version v1.7.0            // Semantic version comparison
```

#### 2. `config/config.go`
- Added `LastUpdateCheckTime` field to Config struct
- Added `GetLastUpdateCheckTime()` method
- Added `SetLastUpdateCheckTime()` method

#### 3. `main.go`
- Added imports for version and update packages
- Added `update` subcommand handling
- Added `handleUpdate()` function
- Added `go version.CheckLatestVersionOfCli()` call on startup
- Updated help text to include update command

## Usage

### User Perspective

#### Automatic Update Notification
When gcool starts, it checks for updates in the background:
```bash
$ gcool
# If update available:
# There is a new version of gcool available: 0.2.0 (you have 0.1.0)
# Please update with 'gcool update'
```

#### Manual Update
```bash
$ gcool update
Updating gcool from 0.1.0 to 0.2.0...
✓ Successfully updated to 0.2.0
```

#### Check Current Version
```bash
$ gcool version
gcool version 0.1.0
```

#### Installation
Initial installation or bootstrap:
```bash
# Latest version globally (requires sudo)
curl -fsSL https://gcool.sh/install.sh | bash

# Latest version to user directory (no sudo)
curl -fsSL https://gcool.sh/install.sh | bash -s -- --user

# Specific version
curl -fsSL https://gcool.sh/install.sh | bash -s -- v0.1.0
```

## Developer Workflow

### Creating a Release

1. **Update version in code**:
   - Edit `main.go` constant `version = "X.Y.Z"`
   - Ensure version matches in `internal/version/version.go` if needed

2. **Create and push tag**:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. **GitHub Actions handles the rest**:
   - `.github/workflows/release.yml` triggers
   - GoReleaser builds all platform binaries
   - GitHub release is created with all artifacts
   - Assets are automatically available for download

### Release Asset Naming

GoReleaser creates assets with this naming convention:
```
gcool_0.2.0_linux_amd64.tar.gz
gcool_0.2.0_linux_arm64.tar.gz
gcool_0.2.0_darwin_amd64.tar.gz
gcool_0.2.0_darwin_arm64.tar.gz
checksums.txt
```

The updater automatically downloads the correct binary for the current platform.

## Configuration

### User Configuration File
Location: `~/.config/gcool/config.json`

Example:
```json
{
  "repositories": {
    "/path/to/repo": {
      "base_branch": "main",
      "last_selected_branch": "feature/xyz"
    }
  },
  "lastUpdateCheckTime": "2025-10-28T10:30:00Z"
}
```

## Security Considerations

1. **HTTPS Only**: All downloads from GitHub use HTTPS
2. **Official Repository**: Only checks `coollabsio/gcool` repository
3. **Semantic Versioning**: Properly validates and compares versions
4. **No Forced Updates**: Users control when to update (manual or notification-based)
5. **Binary Integrity**: go-selfupdate handles verification internally
6. **Rate Limiting**: Checks are rate-limited to prevent excessive API calls

## Error Handling

- Update failures don't crash the application
- Graceful degradation if GitHub API is unavailable
- Clear error messages for troubleshooting
- Non-blocking check ensures normal operation continues

## Dependencies

### Version Checking
- `hashicorp/go-version`: Semantic version comparison
- Standard `net/http`: GitHub API queries
- Standard `encoding/json`: API response parsing

### Binary Updates
- `creativeprojects/go-selfupdate`: Self-update mechanism
- Handles cross-platform binary replacement
- Manages executable permissions

### Release Automation
- **GoReleaser**: Builds and publishes releases
- **GitHub Actions**: Automation workflow

## Future Enhancements

Possible improvements:
1. Delta updates (only download changed portions)
2. Automatic background updates (with user opt-in)
3. Update progress indicators
4. Rollback to previous version
5. Update notifications via system notifications
6. Support for pre-release opt-in flag
7. Custom update server support

## Testing

To test the updater locally:

1. **Test version checking**:
   ```bash
   go run main.go  # Should show update notification if new version available
   ```

2. **Test update command** (against latest release):
   ```bash
   go run main.go update
   ```

3. **Build and test GoReleaser**:
   ```bash
   goreleaser build --snapshot --clean
   ```

## Troubleshooting

### "Cannot find update asset for..." error
- Verify GoReleaser has created the release on GitHub
- Check GitHub releases page for the expected binary
- Ensure tag was pushed correctly

### Update check not running
- Check `~/.config/gcool/config.json` for timestamp
- Verify network connectivity to GitHub API
- Try running with debug flag (when added)

### Cannot write to install directory
- Ensure appropriate permissions
- Use `--user` flag for home directory installation
- Try with `sudo` for system directories
