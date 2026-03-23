# Auto-Update System

Automatic update checking and installation system using Tauri's updater plugin, integrated with GitHub releases and user-friendly dialogs.

## Quick Start

### Current Behavior

- Checks for updates 5 seconds after app launch
- Shows browser `confirm()` dialog when update is available
- Downloads and installs update in background
- Offers to restart app when installation completes
- Fails silently if network issues occur

### Manual Update Check

Users can manually check for updates via:

- **Menu**: App → Check for Updates
- **Command Palette**: Cmd+K → "Check for Updates"

## Architecture

### Update Flow

```
App Launch
    ↓ (5 second delay)
Check GitHub for Updates
    ↓ (if update available)
Show Confirmation Dialog
    ↓ (if user accepts)
Download & Install Update
    ↓ (when complete)
Show Restart Dialog
    ↓ (if user accepts)
Restart Application
```

### Components

1. **Auto-checker**: Runs 5 seconds after app launch
2. **Manual checker**: Triggered by menu/command palette
3. **Progress tracking**: Logs download progress
4. **User dialogs**: Browser-native confirm dialogs
5. **Restart handler**: Uses `@tauri-apps/plugin-process`

## Implementation

### App.tsx Integration

```typescript
// src/App.tsx
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { logger } from '@/lib/logger'

export function App() {
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        logger.info('Checking for updates...')
        const update = await check()

        if (update) {
          logger.info(`Update available: ${update.version}`)

          const shouldUpdate = confirm(
            `Update available: ${update.version}\n\n` +
            `Current version: ${update.currentVersion}\n` +
            `Would you like to download and install this update?`
          )

          if (shouldUpdate) {
            logger.info('User accepted update, starting download...')

            await update.downloadAndInstall((event) => {
              switch (event.event) {
                case 'Started':
                  logger.info(`Downloading update: ${event.data.contentLength} bytes`)
                  break
                case 'Progress':
                  logger.info(`Download progress: ${event.data.chunkLength} bytes`)
                  break
                case 'Finished':
                  logger.info('Update download completed')
                  break
              }
            })

            logger.info('Update installed successfully')

            const shouldRestart = confirm(
              'Update completed successfully!\n\n' +
              'The application needs to restart to apply the update.\n' +
              'Would you like to restart now?'
            )

            if (shouldRestart) {
              logger.info('Restarting application...')
              await relaunch()
            }
          }
        } else {
          logger.info('No updates available')
        }
      } catch (error) {
        logger.error('Update check failed:', error)
        // Fail silently - don't bother user with network issues
      }
    }

    // Check for updates 5 seconds after app starts
    const timer = setTimeout(checkForUpdates, 5000)
    return () => clearTimeout(timer)
  }, [])

  return <MainWindow />
}
```

### Manual Update Check

```typescript
// src/hooks/useMainWindowEventListeners.ts
listen('menu-check-updates', async () => {
  logger.debug('Check for updates menu event received')
  try {
    const update = await check()
    if (update) {
      commandContext.showToast(`Update available: ${update.version}`, 'info')
      // Could trigger the same update flow as auto-check
    } else {
      commandContext.showToast('You are running the latest version', 'success')
    }
  } catch (error) {
    logger.error('Update check failed:', { error: String(error) })
    commandContext.showToast('Failed to check for updates', 'error')
  }
})
```

### Command Palette Integration

```typescript
// src/lib/commands/settings-commands.ts
{
  id: 'check-updates',
  label: 'Check for Updates',
  description: 'Check for app updates',
  group: 'settings',
  execute: async (context) => {
    try {
      const update = await check()
      if (update) {
        context.showToast(`Update available: ${update.version}`, 'info')
      } else {
        context.showToast('You are running the latest version', 'success')
      }
    } catch (error) {
      context.showToast('Failed to check for updates', 'error')
    }
  },
  isAvailable: () => true,
}
```

## Configuration

### Tauri Configuration

```json
// src-tauri/tauri.conf.json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/YOUR_USERNAME/YOUR_REPO/releases/latest/download/latest.json"
      ],
      "dialog": false,
      "pubkey": "YOUR_PUBLIC_KEY_HERE"
    }
  }
}
```

**Key Settings:**

- `active: true`: Enables the updater system
- `endpoints`: GitHub releases URL (template format)
- `dialog: false`: We use custom confirm dialogs instead of Tauri's built-in dialogs
- `pubkey`: Public key for signature verification (set during release setup)

### GitHub Releases Integration

The updater checks GitHub releases for:

1. **latest.json**: Update manifest file
2. **Signed installers**: Platform-specific installation files
3. **Signature files**: `.sig` files for verification

Example `latest.json`:

```json
{
  "version": "1.0.1",
  "notes": "Bug fixes and performance improvements",
  "pub_date": "2024-01-15T10:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "signature": "signature_string",
      "url": "https://github.com/user/repo/releases/download/v1.0.1/app-x86_64.app.tar.gz"
    },
    "darwin-aarch64": {
      "signature": "signature_string",
      "url": "https://github.com/user/repo/releases/download/v1.0.1/app-aarch64.app.tar.gz"
    }
  }
}
```

## Release Integration

### Automatic Generation

The GitHub Actions workflow automatically:

1. Builds signed installers for all platforms
2. Generates `latest.json` manifest
3. Creates GitHub release with all artifacts
4. Publishes release (manual step)

### Manual Release Process

1. Run `bun run release:prepare v1.0.1`
2. Push tags to trigger GitHub Actions
3. Wait for build to complete
4. Manually publish the draft release on GitHub

## User Experience

### Automatic Updates

- **Non-intrusive**: 5-second delay after app launch
- **User choice**: Always asks permission before downloading
- **Progress feedback**: Logs download progress (visible in development)
- **Graceful failure**: Network errors don't bother the user

### Manual Updates

- **Accessible**: Available via menu and command palette
- **Immediate feedback**: Shows toast notifications for results
- **Consistent**: Uses same update flow as automatic checks

### Dialog Messages

**Update Available:**

```
Update available: 1.0.1

Current version: 1.0.0
Would you like to download and install this update?
```

**Update Complete:**

```
Update completed successfully!

The application needs to restart to apply the update.
Would you like to restart now?
```

**No Updates (Manual Check):**

```
You are running the latest version
```

## Security

### Signature Verification

All updates are cryptographically signed:

1. **Key generation**: `tauri signer generate -w ~/.tauri/myapp.key`
2. **Build signing**: GitHub Actions uses private key to sign releases
3. **Verification**: App uses public key to verify download integrity
4. **Automatic rejection**: Invalid signatures are automatically rejected

### Network Security

- **HTTPS only**: All update checks use HTTPS
- **GitHub infrastructure**: Relies on GitHub's security and availability
- **Graceful degradation**: Network failures don't crash the app

## Development vs Production

### Development

- **Logging**: Detailed update logs in browser console
- **Manual testing**: Can test update flow with local builds
- **Debug mode**: Additional logging and error details

### Production

- **Silent failures**: Network errors don't show user dialogs
- **Minimal logging**: Only essential update events logged
- **User-focused**: Clear, simple dialogs and notifications

## Troubleshooting

### Updates Not Detected

1. **Check endpoint URL**: Verify GitHub repository URL in `tauri.conf.json`
2. **Verify public key**: Ensure public key matches signing key
3. **Check release format**: Ensure GitHub release follows expected structure
4. **Network connectivity**: Test manual update check

### Download Failures

1. **Check signatures**: Verify release was signed correctly
2. **File permissions**: Ensure app has write permissions for updates
3. **Disk space**: Verify sufficient space for download and installation
4. **Network stability**: Check for connection interruptions

### Installation Issues

1. **App permissions**: Verify app can modify itself
2. **Running instances**: Close all app instances before installation
3. **Antivirus software**: Check if antivirus is blocking installation
4. **System updates**: Ensure system is compatible with new version

## CLI Upgrade Minimization

Separate from the app auto-update system, Jean manages CLI tools (Claude CLI, GitHub CLI, Codex CLI, OpenCode CLI) that can be upgraded via toast notifications. These upgrades run through two modal types:

- **CliReinstallModal**: Progress-bar dialog for jean-managed installs (download binary from GitHub)
- **CliLoginModal**: Full-screen xterm terminal for Homebrew/PATH-based upgrades (`brew upgrade`, `claude update`)

Both modals support **minimization** — clicking the Minus button in the modal header closes the modal but keeps the upgrade running in the background. A small indicator pill appears in the titlebar (top-right, next to the app update indicator) showing:

- CLI name and progress percentage (for reinstall mode)
- CLI name and "updating..." (for terminal/login mode)

On completion, the indicator auto-clears and shows a success/error toast. Users can also dismiss the indicator with the X button.

### Minimize Button Positioning

The minimize button (Minus icon) is positioned absolutely (`absolute top-4 right-14`) to sit to the left of the Dialog's built-in close (X) button (`absolute top-4 right-5`). Both use identical styling for visual consistency. The minimize button is rendered outside `DialogHeader` as a sibling of the dialog content.

### CLI Usage Guard During Updates

When a CLI is being updated (minimized, reinstall modal open, or login modal open), message sending is blocked for that CLI's backend. The guard lives in `useMessageSending.ts`:

```typescript
const cliType = (queuedMsg.backend ?? 'claude') as 'claude' | 'codex' | 'opencode'
const uiState = useUIStore.getState()
const isUpdating =
  uiState.minimizedCliUpdate?.type === cliType ||
  (uiState.cliUpdateModalOpen && uiState.cliUpdateModalType === cliType) ||
  (uiState.cliLoginModalOpen && uiState.cliLoginModalType === cliType)
```

If the CLI is updating, the user sees an error toast: *"[CLI Name] is currently being updated. Please wait for the update to complete."*

### Restore from Minimized State

- **Reinstall mode**: Clicking the titlebar indicator re-opens the `CliUpdateModal`, which picks up fresh progress events
- **Login mode**: The PTY terminal UI was detached on minimize and cannot be re-attached, so clicking does nothing — the user can only dismiss with the X button or wait for completion

### Implementation

- **State**: `minimizedCliUpdate` in `ui-store.ts` tracks the minimized upgrade
- **Indicator**: `MinimizedCliUpdate` component in `src/components/titlebar/MinimizedCliUpdate.tsx`
- **Event listeners**: Reinstall mode listens to `${type}-cli:install-progress`, login mode uses `setOnStopped()` on the terminal instance
- **PTY safety**: `CliLoginModal` uses a `minimizingRef` to skip PTY cleanup on minimize (the `MinimizedCliUpdate` component handles cleanup on completion)
- **Send guard**: `useMessageSending.ts` checks `minimizedCliUpdate`, `cliUpdateModalOpen`, and `cliLoginModalOpen` before sending messages

## Future Enhancements

### Planned Improvements

- **Better progress UI**: Replace confirm dialogs with custom update UI
- **Background downloads**: Download updates silently, install on restart
- **Rollback capability**: Ability to revert to previous version
- **Update channels**: Support for beta/stable release channels

### Advanced Configuration

```json
// Future: More sophisticated updater config
{
  "updater": {
    "active": true,
    "dialog": false,
    "endpoints": ["https://api.example.com/updates"],
    "installMode": "passive",
    "allowDowngrade": false,
    "checkInterval": 3600000
  }
}
```

The auto-update system provides seamless, secure updates while maintaining user control and graceful error handling.
