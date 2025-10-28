# gcool Updater - Quick Start Guide

## For Users

### Check your version
```bash
gcool version
```

### Update to latest
```bash
gcool update
```

### Initial installation
```bash
# Install latest version
curl -fsSL https://gcool.sh/install.sh | bash

# Install to user directory (no sudo needed)
curl -fsSL https://gcool.sh/install.sh | bash -s -- --user

# Install specific version
curl -fsSL https://gcool.sh/install.sh | bash -s -- v0.1.0
```

## For Developers/Maintainers

### How to create a new release

1. **Update version in code**:
   ```bash
   # Edit main.go and update:
   const version = "0.2.0"
   ```

2. **Create git tag and push**:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. **Let GitHub Actions do the rest**:
   - Workflow triggers automatically
   - Builds for all platforms
   - Creates GitHub release with assets
   - Users can now `gcool update` to get it

### Testing locally

```bash
# Build the binary
go build -o gcool

# Test version command
./gcool version

# Test help shows update command
./gcool help

# Test update command (will check GitHub)
./gcool update
```

## Implementation Details

### Files Created:
- `internal/version/version.go` - Auto-check logic
- `internal/update/update.go` - Update mechanism
- `.goreleaser.yml` - Release config
- `scripts/install.sh` - Installation script
- `.github/workflows/release.yml` - CI/CD automation

### Files Modified:
- `config/config.go` - Added last update check time
- `main.go` - Added update command & auto-check
- `go.mod` - Added dependencies

## How It Works

### Automatic Updates (Passive)
- Checks for updates on every startup
- Rate-limited to once every 10 minutes
- Non-blocking (happens in background)
- Stores last check time in config
- Notifies user if new version available

### Manual Updates (Active)
- User runs `gcool update`
- Downloads latest binary from GitHub
- Creates backup of current binary
- Replaces with new version
- Reports success/failure

## Supported Platforms

✓ Linux (amd64, arm64)
✓ macOS (amd64, arm64)

## Configuration

Auto-check timestamp stored in:
```
~/.config/gcool/config.json
```

Example:
```json
{
  "lastUpdateCheckTime": "2025-10-28T14:32:00Z"
}
```

## Troubleshooting

**"gcool is already up to date"**
- You're running the latest version
- No action needed

**"failed to detect latest version"**
- Check GitHub API availability
- Verify internet connection
- Repository might be private

**Update command not found**
- Rebuild with latest code
- Run: `go build -o gcool`

## Deployment Checklist

- [ ] Create v0.1.0 tag in GitHub
- [ ] Verify GitHub Actions workflow runs
- [ ] Check GitHub Releases page for artifacts
- [ ] Test `gcool update` command
- [ ] Set up `gcool.sh` DNS (optional)
- [ ] Update README with installation instructions
- [ ] Announce release to users
