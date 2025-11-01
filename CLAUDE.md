# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

gcool is a Terminal User Interface (TUI) for managing Git worktrees with integrated tmux session management. It's built in Go using the Bubble Tea framework for the TUI and provides persistent Claude CLI sessions per worktree.

## Development Commands

### Build and Run
```bash
# Run locally
go run main.go

# Run with custom repository path (for testing)
go run main.go -path /path/to/test/repo

# Build binary
go build -o gcool

# Install to system
sudo cp gcool /usr/local/bin/
```

### Testing
```bash
# Initialize/update dependencies
go mod tidy

# Verify the build
go build -o gcool

# Test with different flags
./gcool --version
./gcool --help
./gcool --no-claude
```

## Architecture

The application follows a clean separation of concerns:

### Package Structure
- **main.go**: CLI entry point, handles flags and shell integration output
- **tui/**: Bubble Tea TUI implementation (MVC pattern)
  - `model.go`: State management, data structures, and Tea commands
  - `update.go`: Event handling and state transitions
  - `view.go`: UI rendering logic
  - `styles.go`: Lipgloss styling definitions
  - `themes.go`: Theme definitions and system (5 themes: matrix, coolify, dracula, nord, solarized)
- **git/**: Git worktree operations wrapper
  - `worktree.go`: All git worktree CRUD operations, branch management, and random name generation
- **session/**: Tmux session management
  - `tmux.go`: Session creation, attachment, listing, and lifecycle management
  - `claude_status.go`: Real-time Claude status detection (busy/ready states)
- **config/**: User configuration persistence
  - `config.go`: Manages base branch settings per repository in `~/.config/gcool/config.json`
  - `scripts.go`: Loads and manages custom scripts from `gcool.json`
- **github/**: GitHub PR operations
  - `pr.go`: PR creation, listing, merging via gh CLI
- **openrouter/**: AI integration
  - `client.go`: OpenRouter API client for commit messages, branch names, PR content generation
- **install/**: Installation utilities and shell wrapper templates
  - `templates.go`: Embedded shell wrapper templates (BashZshWrapper, FishWrapper) compiled into binary

### Detailed File Structure

#### tui/model.go
Key components:
- `Model` struct: Main application state (lines 13-33)
  - `worktrees []git.Worktree`: List of all worktrees
  - `cursor int`: Selected worktree index
  - `modal modalType`: Current active modal
  - `sessions []tmux.Session`: Active tmux sessions
  - Various modal-specific state fields
- `modalType` enum: Defines all modal types (lines 36-44)
- Message types: All async operation results (e.g., `worktreesLoadedMsg`, `worktreeCreatedMsg`)
- Tea command functions: Wrap async operations (e.g., `loadWorktrees()`, `createWorktree()`)

#### tui/update.go
Event handling logic:
- `Update(msg tea.Msg)`: Main message router (lines 12-148)
- `handleMainInput(msg tea.KeyMsg)`: Main view keybindings (lines 150-262)
- `handleModalInput(msg tea.KeyMsg)`: Routes to modal-specific handlers (lines 264-695)
- Modal handlers:
  - `handleCreateModalInput()`: New worktree creation
  - `handleDeleteModalInput()`: Deletion confirmation
  - `handleBranchSelectModalInput()`: Branch selection for worktree
  - `handleCheckoutBranchModalInput()`: Checkout branch in main repo
  - `handleSessionListModalInput()`: Tmux session management
  - `handleRenameModalInput()`: Branch renaming
  - `handleChangeBaseBranchModalInput()`: Base branch selection

#### tui/view.go
UI rendering:
- `View()`: Main render function, delegates to modal or main view
- `renderMainView()`: Worktree list and status
- Modal renderers: `renderCreateModal()`, `renderDeleteModal()`, etc.
- `renderHelpBar()`: Bottom help text with keybindings
- Uses lipgloss styles from `styles.go`

#### git/worktree.go
Git operations wrapper:
- `Manager` struct: Handles all git worktree operations
- `ListWorktrees()`: Get all worktrees and their status
- `AddWorktree()`: Create new worktree
- `RemoveWorktree()`: Delete worktree and optionally its branch
- `GetBranches()`: List all local and remote branches
- `RenameBranch()`: Rename current branch
- `CheckoutBranch()`: Switch branch in main repository
- `GenerateRandomName()`: Create random branch names (adjective-noun-number)

#### session/tmux.go
Tmux integration:
- `CreateOrAttachSession()`: Create new tmux session or attach to existing
- `ListSessions()`: Get all active tmux sessions
- `KillSession()`: Terminate a tmux session
- `SessionExists()`: Check if session is running
- `SanitizeSessionName()`: Convert branch names to valid tmux session names
- `HasGcoolTmuxConfig()`: Check if gcool config is installed in ~/.tmux.conf
- `AddGcoolTmuxConfig()`: Install or update gcool tmux config (with unique markers)
- `RemoveGcoolTmuxConfig()`: Remove gcool config section from ~/.tmux.conf

#### config/config.go
Configuration management:
- `Config` struct: Stores repository-specific settings
- `RepoConfig` struct: Base branch, editor, last selected branch
- `LoadConfig()`: Read from `~/.config/gcool/config.json`
- `SaveConfig()`: Persist configuration changes
- `GetBaseBranch()`: Get base branch for repository
- `SetBaseBranch()`: Update base branch setting
- `GetEditor()`: Get preferred editor for repository (defaults to "code")
- `SetEditor()`: Update editor preference
- `GetLastSelectedBranch()`: Get last selected branch for auto-restore
- `SetLastSelectedBranch()`: Save last selected branch

### Key Architectural Patterns

**Bubble Tea MVC**: The TUI follows the Bubble Tea pattern:
- Model holds all state (worktrees, branches, sessions, UI state, modals)
- Update handles messages (keyboard input, async operation results)
- View renders the UI based on current model state

**Async Operations**: Git and tmux operations are wrapped in Tea commands that return messages:
- Operations like `loadWorktrees()`, `createWorktree()`, `deleteWorktree()` run asynchronously
- Results are delivered via typed messages (`worktreesLoadedMsg`, `worktreeCreatedMsg`, etc.)
- The Update function handles these messages and updates state accordingly

**Shell Integration Protocol**: The app communicates with shell wrappers via:
- Environment variable `GCOOL_SWITCH_FILE` (preferred): Write switch data to file
- Stdout (legacy): Print switch data in format `path|branch|auto-claude|terminal-only`
- Shell wrappers read this data to perform `cd` and tmux session management

**Modal Management**: The TUI uses a modal system (`modalType` enum) for different operations:
- `createModal`: Create new worktree with new branch
- `deleteModal`: Confirm worktree deletion
- `branchSelectModal`: Select existing branch for worktree (with search/filter)
- `sessionListModal`: View and manage tmux sessions
- `renameModal`: Rename current branch
- `changeBaseBranchModal`: Change base branch for new worktrees (with search/filter)
- `editorSelectModal`: Select preferred editor for opening worktrees
- `settingsModal`: Configure application settings
- `tmuxConfigModal`: Install/update/remove tmux configuration

**Session Naming**: Tmux session names are sanitized from branch names:
- Claude sessions: `gcool-<sanitized-branch-name>`
- Terminal sessions: `gcool-<sanitized-branch-name>-terminal`
- Invalid characters replaced with hyphens
- Both session types can coexist for the same worktree

**Worktree Organization**: All worktrees are created in `.workspaces/` directory at repository root:
- Random names generated from adjectives + nouns + numbers (e.g., `happy-panda-42`)
- Keeps workspace organized and prevents directory conflicts

**Search/Filter Pattern**: Branch selection modals use a consistent search pattern:
- `searchInput` textinput for typing filter queries
- `filteredBranches` slice stores filtered results
- `filterBranches()` helper method performs case-insensitive substring matching
- Real-time filtering as user types
- Focus management: search input → list → buttons (via Tab)
- Used in: branchSelectModal, checkoutBranchModal, changeBaseBranchModal

## Configuration

**User Config Location**: `~/.config/gcool/config.json`
- Stores per-repository settings and integration configs
- Complete JSON structure:
```json
{
  "repositories": {
    "<repo-path>": {
      "base_branch": "main",
      "editor": "code",
      "last_selected_branch": "feature/my-branch",
      "openrouter_api_key": "sk-...",
      "openrouter_model": "gpt-4-turbo",
      "ai_commit_enabled": true,
      "ai_branch_name_enabled": true,
      "debug_logging_enabled": false,
      "theme": "matrix",
      "auto_fetch_interval": "10s",
      "prs": {
        "feature-branch": "https://github.com/owner/repo/pull/123"
      },
      "claude_initialized": {
        "main": true,
        "feature-branch": true
      }
    }
  }
}
```

**Base Branch Logic**:
1. Check saved config for repository
2. Fall back to current branch
3. Fall back to default branch (main/master)
4. Fall back to empty string (user must set manually)

**Editor Integration**:
- Supports 7 popular editors: code, cursor, nvim, vim, subl, atom, zed
- Press `o` to open worktree in configured editor
- Press `e` to select/change editor (also accessible via settings menu)
- Editor preference stored per repository

**Last Selected Worktree Persistence**:
- Automatically saves last selected worktree branch
- Restores selection when reopening gcool
- Updates on navigation (up/down keys) and switching

**Tmux Configuration Management**:
- Opinionated tmux config can be installed to `~/.tmux.conf`
- Config is marked with unique identifiers for safe updates/removal
- Includes: mouse support, Ctrl-D detach, 10k scrollback, 256 colors
- Accessible via settings menu → Tmux Config
- Supports install, update, and remove operations

**Setup Script Integration** ✅:
- Automatic script execution when creating new worktrees
- Configure in `gcool.json` at repository root:
```json
{
  "scripts": {
    "onWorktreeCreate": "npm install && cp $GCOOL_ROOT_PATH/.env ."
  }
}
```
- Environment variables available in script:
  - `GCOOL_WORKSPACE_PATH`: Path to the newly created worktree
  - `GCOOL_ROOT_PATH`: Path to the repository root directory
- Script runs every time a worktree is created (no marker file tracking)
- Executes for ALL new worktrees (created with `n` or `a` keys)
- Script failures show as warnings, not errors (worktree still usable)
- Script output captured and displayed in notification on failure
- Common use cases:
  - Copy environment files from repo root
  - Install dependencies (npm install, go mod download, etc.)
  - Setup symlinks to shared resources
  - Initialize local configuration files

## Dependencies

Key external dependencies:
- `github.com/charmbracelet/bubbletea`: TUI framework
- `github.com/charmbracelet/lipgloss`: Terminal styling
- `github.com/charmbracelet/bubbles`: TUI components (textinput)

## New Features (Latest Implementation)

### AI Integration (OpenRouter) ✅
**Files**: `openrouter/client.go`, `tui/model.go`, `config/config.go`

**Features**:
1. **AI Commit Message Generation** (tui/model.go:976-1003)
   - Automatically generates conventional commit messages from git diff
   - Triggered by pressing `c` with AI enabled in settings
   - Shows spinner animation during generation
   - Supports 11 AI models via OpenRouter (Gemini, Claude, GPT-4, Llama, etc.)
   - Falls back to empty message if generation fails
   - Requires API key configuration in AI Settings modal

2. **AI Branch Name Generation** (tui/model.go:1005-1084)
   - Generates semantic branch names from git changes
   - Automatically used in PR creation flow (`P` key)
   - Also used in push flow (`p` key) when enabled
   - Replaces random names with meaningful convention (e.g., `feat/user-authentication`)
   - Graceful fallback to current branch name if generation fails

3. **AI PR Content Generation** (tui/model.go:1113-1156)
   - Generates PR title and description from git diff
   - Integrated into PR creation workflow
   - User can review and manually edit before submission
   - Modal-based editing with Tab navigation
   - Can be retried automatically on PR creation conflicts

**Configuration**:
- API Key: Stored in config with `openrouter_api_key` field
- Model Selection: Choose from 11+ models via settings
- Toggles: `ai_commit_enabled` and `ai_branch_name_enabled` flags
- Test API key function in AI Settings modal
- Models include: GPT-4, Claude 3 Opus, Gemini Pro, Llama 2, and more

### GitHub PR Integration ✅
**Files**: `github/pr.go`, `tui/model.go`, `tui/view.go`, `tui/update.go`

**Features**:
1. **Create Draft PR** (`P` keybinding, lines 1418-1496 in update.go)
   - Auto-commits uncommitted changes with AI if enabled
   - Renames random branch names to semantic names with AI (optional)
   - Generates PR title/description with AI (optional)
   - Pushes to remote and creates draft PR via `gh` CLI
   - Stores PR URL in config per branch
   - Displays PR link in worktree details panel
   - Supports retry on PR creation conflicts with regenerated content

2. **Create Worktree from PR** (`N` keybinding, lines 1498-1506)
   - Lists all open PRs with search/filter capabilities
   - Search by title, author, or branch name
   - Paginated display fitting terminal height
   - Creates worktree from selected PR's branch
   - Automatically names worktree from PR number and title

3. **View PR in Browser** (`v` keybinding, lines 1548-1569)
   - Opens PR URL in default browser using `gh` CLI
   - Supports multiple PRs per branch with selection modal
   - Uses hyperlinks with OSC 8 terminal codes for clickable links

4. **Merge PR** (`M` keybinding, lines 1571-1591)
   - Strategy selection modal:
     - Squash and merge (single commit)
     - Create a merge commit (standard)
     - Rebase and merge (linear history)
   - Integrated with `gh` CLI for secure merging
   - Confirmation before merge execution

5. **PR Status Tracking**
   - PR URLs stored per branch in config
   - Visual link in worktree details panel (clickable terminal links)
   - Shows PR status (draft, ready, merged)
   - Integrated with commit flow (prompt to create PR after commit)

### Scripts System ✅
**Files**: `config/scripts.go`, `tui/model.go`, `tui/view.go`, `tui/update.go`

**Features**:
1. **Custom Scripts from gcool.json** (`;` keybinding, lines 1330-1340)
   - Load scripts from `gcool.json` in repository root
   - Run arbitrary bash commands on selected worktrees
   - Real-time streaming output with live updates
   - Script execution tracking (start time, output, finished status)
   - Structure:
     ```json
     {
       "scripts": {
         "run": "npm start",
         "test": "npm test",
         "build": "npm run build",
         "custom": "custom command"
       }
     }
     ```

2. **Run Script** (`R` keybinding, lines 1099-1141)
   - Quick-run the 'run' script from gcool.json
   - Opens script output modal automatically
   - Shows running scripts with elapsed time
   - Spinner animation during execution

3. **Scripts Modal** (view.go:1943-2056)
   - Lists running scripts with status indicators
   - Lists available scripts from gcool.json
   - Kill running scripts with `d` or `k` key
   - View script output in separate modal
   - Color-coded status (running, finished)

4. **Script Output Modal** (view.go:2058-2126)
   - Real-time streaming output (polls every 200ms)
   - Shows elapsed time and finish status
   - Scrollable output display with last 30 lines visible
   - Kill script with `k` key
   - Close modal with `q` or `esc`

**Environment Variables Available to Scripts**:
- `GCOOL_WORKSPACE_PATH`: Full path to worktree directory
- `GCOOL_ROOT_PATH`: Full path to repository root
- `GCOOL_BRANCH`: Current branch name

### Themes System ✅
**Files**: `tui/themes.go`, `tui/styles.go`, `config/config.go`

**5 Built-in Themes**:
1. **Matrix** - Classic green terminal aesthetic
   - Primary: Green (#00FF00)
   - Accent: Bright green (#00FF41)
   - Background: Black (#000000)

2. **Coolify** - Purple/violet theme
   - Primary: #9D4EDD (purple)
   - Accent: #E0AAFF (light purple)
   - Background: #10002B (dark purple)

3. **Dracula** - Pink/purple theme
   - Primary: #FF79C6 (pink)
   - Accent: #8BE9FD (cyan)
   - Background: #282A36 (dark gray)

4. **Nord** - Blue/cyan theme
   - Primary: #81A1C1 (blue)
   - Accent: #88C0D0 (cyan)
   - Background: #2E3440 (dark)

5. **Solarized** - Blue/teal theme
   - Primary: #268BD2 (blue)
   - Accent: #2AA198 (teal)
   - Background: #002B36 (dark)

**Features**:
- Theme selection modal accessible via settings (`s` → Theme)
- Navigate with up/down, confirm with enter
- Preview theme metadata before selection
- Save theme per repository in config
- Dynamic theme switching without restart (lines 959-973 in model.go)
- Theme applied on startup from config (lines 406-411 in model.go)

### Claude Status Detection ✅
**Files**: `session/claude_status.go`, `tui/model.go`, `tui/view.go`

**Features**:
1. **Real-time Status Monitoring** (model.go:1690-1722)
   - Polls tmux session every 1.5 seconds
   - Detects busy/ready states by analyzing pane content
   - Uses StatusDetector per session (model.go:239-241)
   - Non-blocking polling doesn't interfere with user input

2. **Visual Status Indicators** (view.go:135-147)
   - Animated spinner for busy state (10-frame: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
   - Green dot (●) for ready state
   - Shown in worktree list and details panel
   - Color-coded status display

3. **Status Detection Algorithm** (session/claude_status.go:45-64)
   - Captures last 5 lines of tmux pane
   - Checks for busy indicators:
     - "Thinking"
     - "Building context"
     - "Executing tool"
     - "Running"
     - "Processing"
   - Detects output stability for ready state (2s threshold)
   - Smooth transitions between states

### Debug Logging ✅
**Files**: `tui/update.go`, `config/config.go`

**Features**:
- Toggle in Settings modal (`s` → Debug Logs)
- Logs to `/tmp/gcool-debug.log`
- Tracks:
  - Worktree operations (create, delete, switch)
  - PR creation flows
  - Commit operations
  - AI integrations
  - GitHub operations
- Conditional logging based on `debug_logging_enabled` config flag
- Useful for troubleshooting and development

### Advanced Worktree Management ✅
**Features**:
1. **Auto-sorting by Last Modified** (model.go:1753-1771)
   - Root worktree always first
   - Workspace worktrees sorted by modification time (most recent first)
   - Automatically sorts after worktree load

2. **Worktree Ensure Before Switch** (update.go:994-999, 1214-1226)
   - Always ensures worktree exists before switching
   - Prevents errors from stale/deleted worktrees
   - Shows "Preparing workspace..." notification
   - Atomic switch operation

3. **Dual Session Mode** (update.go:1197-1227, 1268-1289)
   - `enter` - Opens Claude session (`gcool-<branch>`)
   - `t` - Opens terminal session (`gcool-<branch>-terminal`)
   - Both sessions can coexist for same worktree
   - Independent session lifecycle management

4. **Session Persistence** (update.go:1205-1213)
   - Tracks Claude initialization per branch in config
   - Uses `--continue` flag for initialized sessions
   - First run uses plain `claude` command (starts fresh context)
   - Subsequent runs reuse session context

### Pull from Base Branch ✅
**Features** (`u` keybinding, lines 1342-1358):
- Fetches latest changes from remote
- Checks if worktree is behind base branch
- Merges base branch into worktree branch
- Merge conflict detection and graceful abort option
- Only works on workspace worktrees (safety check)
- Shows detailed merge status in notifications

### Refresh with Auto-Pull ✅
**Features** (`r` keybinding, lines 1094-1097):
- Fetches from remote
- Pulls ALL worktrees (main repo + workspace branches)
- Skips worktrees with uncommitted changes
- Shows detailed status message with commit counts per branch
- Parses pull output to show commits pulled

### Push to Remote ✅
**Features** (`p` keybinding, lines 1360-1416):
- Checks for uncommitted changes
- Auto-commits with AI if enabled
- Renames random branch names with AI (optional)
- Pushes to remote with force-with-lease safety
- Shows detailed status notifications

### Notification System ✅
**Notification Types** (model.go:82-90):
- **Success** (green, 2-3s auto-clear) - Successful operations
- **Error** (red, 4-5s auto-clear) - Failures with details
- **Warning** (yellow, 3s auto-clear) - Non-critical issues
- **Info** (blue, 3s auto-clear) - Informational messages

**Features** (view.go:306-385):
- Centered at bottom of screen
- Non-blocking overlay (doesn't replace main view)
- Auto-dismiss with configurable duration
- Unique ID system to prevent stale notifications
- Color-coded for quick scanning

## Extension Points

### Implemented Features

**Editor Integration** ✅:
- `o` keybinding to open worktree in default IDE
- `e` keybinding to select/change editor
- Support for 7 editors: VS Code, Cursor, Neovim, Vim, Sublime Text, Atom, Zed
- Per-repository editor preference stored in `~/.config/gcool/config.json`

**Enhanced Configuration** ✅:
- Settings menu (`s` keybinding) for centralized configuration
- Editor preferences stored per repository
- Base branch configuration per repository
- Last selected worktree persistence
- Tmux configuration management (install/update/remove)

**Branch Management** ✅:
- Branch rename protection (prevents renaming main branch)
- Search/filter for branch selection modals

**Commit Modal** ✅:
- Press `C` (Shift+C) to open commit modal when there are uncommitted changes
- Two-field commit message: subject (required) + body (optional)
- Tab to cycle through fields and buttons
- Enter to confirm commit, Esc to cancel
- Shows commit hash on success (first 8 characters)
- Auto-refreshes worktree list after successful commit
- Full git commit flow: stages all changes with `git add -A`, then commits with subject and body

**Worktree Setup Scripts** ✅:
- Automatic execution of setup scripts when creating new worktrees
- Configured via `gcool.json` in repository root using `scripts.onWorktreeCreate` key
- Provides `GCOOL_WORKSPACE_PATH` and `GCOOL_ROOT_PATH` environment variables to scripts
- Runs every time a worktree is created (no marker file tracking)
- Runs for all worktree creation methods (new branch with `n`, existing branch with `a`)
- Script failures are non-blocking - displayed as warnings, not errors
- Full script output captured and shown in notification for debugging
- Scripts modal (`;` key) displays `onWorktreeCreate` as view-only (cannot be manually executed)
- Implementation details:
  - `config/scripts.go`: Loads `gcool.json` configuration
  - `git/worktree.go`: `executeSetupScript()` method handles execution
  - `tui/update.go`: Distinguishes setup script warnings from git errors
  - `tui/model.go`: Filters `onWorktreeCreate` from runnable scripts list
  - `tui/view.go`: Shows `onWorktreeCreate` in separate "Automatic Scripts (view-only)" section
  - Error format: "setup script failed: [error details]" triggers warning display

**Automatic Base Branch Update Detection** ⚠️ (NOT YET TESTED):
- Periodic checks every 10 seconds (configurable) for base branch updates
- Automatically fetches from remote without user intervention
- Displays visual indicators showing which worktrees are behind base branch
- Behind count displayed as `↓X` next to worktree names (e.g., `↓3` for 3 commits behind)
- Shows ahead/behind status in the details panel
- Per-repository configurable fetch interval (5s/10s/30s/60s) in `~/.config/gcool/config.json`
- **Status**: Implemented but NOT tested - will be tested in follow-up session

**Pull from Base Branch** ⚠️ (NOT YET TESTED):
- Press `P` (Shift+P) to pull changes from base branch into selected worktree
- Only available when worktree is behind the base branch (safe mode)
- Automatically fetches latest changes first, then merges base branch
- Graceful merge conflict handling with abort option
- Shows "Merge conflict! Run 'git merge --abort' to abort." message on conflicts
- Only works on workspace worktrees (in `.workspaces/` directory)
- **Status**: Implemented but NOT tested - will be tested in follow-up session

### Implementation Details (New Features)

**Commit Modal Feature**:

Files Modified:
1. `git/worktree.go`: Added `CreateCommit()` method
   - Stages all changes with `git add -A`
   - Creates commit with subject and optional body using `git commit -m "subject" -m "body"`
   - Parses commit hash from output or falls back to `git rev-parse HEAD`
   - Returns commit hash on success
2. `tui/model.go`: Added commit modal state and messages
   - Added `commitModal` to `modalType` enum
   - Added `commitSubjectInput` and `commitBodyInput` textinput fields to `Model`
   - Added `commitCreatedMsg` message type with error and commitHash fields
   - Added `createCommit()` command function that wraps git operation
3. `tui/update.go`: Added keybinding and input handler
   - Added `C` (Shift+C) keybinding to open commit modal (checks for uncommitted changes first)
   - Added `handleCommitModalInput()` for Tab/Enter/Esc navigation
   - Tab cycles: subject → body → commit button → cancel button
   - Enter in input fields moves to next field, on button confirms action
   - Added `commitCreatedMsg` handler in `Update()` that refreshes worktree list
4. `tui/view.go`: Added modal renderer
   - Added `renderCommitModal()` function with focused field styling
   - Updated help bar to show "C commit" keybinding
   - Removed "c" and "C" from help bar, replaced with "b base" and "K checkout"

**Keybinding Changes**:
- Rebind `c` → `b` for changing base branch
- Rebind `C` → `K` for checking out branch in main repo (originally)
- New `C` (Shift+C) keybinding for commit modal

**Architecture Notes**:
- Commit modal uses same text input pattern as rename modal with Tab cycling
- Focus states: 0=subject, 1=body, 2=commit button, 3=cancel button
- Commits are atomic: if `git add -A` fails, commit is not attempted
- Uses `git add -A` to include untracked files, modified files, and deletions
- Hash parsing is robust: tries output parsing first, falls back to `git rev-parse HEAD`

**Files Modified (Branch Update Feature)**:
1. `git/worktree.go`: Added `FetchRemote()`, `GetBranchStatus()`, `MergeBranch()`, `AbortMerge()` methods
   - Updated `Worktree` struct with `BehindCount`, `AheadCount`, `IsOutdated` fields
2. `config/config.go`: Added `AutoFetchInterval` field to `RepoConfig`
   - Added `GetAutoFetchInterval()` and `SetAutoFetchInterval()` methods
3. `tui/model.go`: Added periodic check scheduling and branch status tracking
   - Added `lastFetchTime`, `fetchInterval` fields to `Model`
   - Added `scheduleBranchCheck()`, `checkBranchStatuses()`, `pullFromBaseBranch()` commands
   - Added `tickMsg`, `branchStatusCheckedMsg`, `branchPulledMsg` message types
4. `tui/update.go`: Added event handlers for periodic checks and pull operations
   - Added `P` keybinding for pulling from base branch
   - Handlers for `tickMsg`, `branchStatusCheckedMsg`, `branchPulledMsg`
5. `tui/view.go`: Updated UI to show branch status
   - Worktree list shows `↓X` indicator for behind count
   - Details panel shows ahead/behind status with pull hint
   - Help bar dynamically shows "P pull" when applicable
6. `tui/styles.go`: Added `successColor` for up-to-date status display

**Architecture Notes (Branch Update)**:
- Uses Bubble Tea's `tea.Every()` for periodic tick messages (every 10s by default)
- Fetch operations are non-blocking - failures don't interrupt user workflow
- Status checks only run if enough time has passed (configurable interval)
- Branch status is cached per worktree and updated on periodic checks
- Pull operation is gated on safety checks (only workspace branches, only when behind)

### Potential Future Additions

**Worktree Management**:
- Bulk operations: Delete multiple worktrees at once
- Archive old worktrees instead of deleting
- Search/filter worktrees by name or branch
- Sort worktrees by last modified, creation date, or alphabetically

**Branch Management**:
- Create branch from specific commit or tag
- Interactive rebase support
- Merge/rebase branches from TUI
- Show branch history and commits

**Session Management**:
- Multiple session types per worktree (Claude, terminal, editor)
- Session templates (e.g., "start with vim + tmux split + claude")
- Persistent session layouts
- Integration with other tools beyond Claude CLI

**UI Enhancements**:
- Color themes and customization
- Show git status (dirty/clean) per worktree
- Display last commit message for each worktree
- Show active sessions indicator on worktree list

### Adding New External Integrations

The current tmux integration pattern (`session/tmux.go`) can be extended to support other tools:

1. Create new package (e.g., `editor/`) with similar structure to `session/`
2. Define interface for editor operations (open, close, check if running)
3. Implement adapters for different editors (VSCode, Vim, etc.)
4. Add configuration options to select preferred editor
5. Create Tea commands in `tui/model.go` to invoke editor operations
6. Add keybindings in `tui/update.go`

### Testing Strategies

**Unit Tests**:
- Git operations: Mock `exec.Command` for git commands
- Session management: Test session name sanitization, mock tmux commands
- Configuration: Test JSON serialization, file I/O with temp directories

**Integration Tests**:
- Set up test git repository with worktrees
- Verify worktree creation/deletion
- Test session creation and cleanup
- Verify configuration persistence

**TUI Testing**:
- Use Bubble Tea's test utilities for message handling
- Test keyboard input handling with mock messages
- Verify state transitions through modal flows
- Test async operation message handling

## Module Information

**Module Name**: `github.com/coollabsio/gcool`

All internal imports use `github.com/coollabsio/gcool` as the import path. When adding new packages, use this as the base path:
- `github.com/coollabsio/gcool/tui`
- `github.com/coollabsio/gcool/git`
- `github.com/coollabsio/gcool/config`
- `github.com/coollabsio/gcool/session`

## Prerequisites

- **Git**: Required for all worktree operations
- **tmux**: Required for persistent session management
- **Go 1.21+**: For development

## Keybindings

All keybindings are defined in `tui/update.go` (lines 1068-1600). The application uses Bubble Tea's native `tea.KeyMsg` system with string-based matching.

### Main View Keybindings

**Navigation**:
- `↑` / `up` / `k` - Move cursor up (lines 1076-1083)
- `↓` / `down` / `j` - Move cursor down (lines 1085-1092)
- `q` / `ctrl+c` - Quit application (lines 1071-1074)

**Worktree Management**:
- `n` - Create new worktree with custom session name (lines 1143-1155)
  - Opens modal for custom naming, shows random name suggestion
  - Sets Claude initialization status
- `a` - Create worktree from existing branch (lines 1168-1177)
  - Opens branch selection modal with search/filter
- `d` - Delete selected worktree (lines 1179-1195)
  - Opens confirmation modal before deletion
- `r` - Refresh: fetch from remote and auto-pull all branches (lines 1094-1097)
  - Skips worktrees with uncommitted changes
  - Shows detailed pull status with commit counts
- `R` (Shift+R) - Run 'run' script on selected worktree (lines 1099-1141)
  - Executes `run` script from gcool.json
  - Opens script output modal
- `;` (semicolon) - Open scripts modal (lines 1330-1340)
  - View available scripts and their status
  - Kill running scripts with `d` key
- `o` - Open worktree in default editor (lines 1291-1296)
  - Uses configured editor (code, cursor, nvim, vim, subl, atom, zed)

**Git Operations**:
- `b` - Change base branch for new worktrees (lines 1157-1166)
  - Opens branch selection modal with search
- `B` (Shift+B) - Rename current branch (lines 1229-1248)
  - Opens rename modal with protection against main branch renames
  - Shows branch name sanitization
- `K` (Shift+K) - Checkout/switch branch in main repository (lines 1258-1266)
  - Opens checkout modal with all branches
- `c` - Commit changes (lines 1508-1546)
  - Opens commit modal with subject + body fields
  - With AI enabled: generates commit message from diff
  - Tab cycles through fields: subject → body → commit → cancel
- `p` (lowercase) - Push to remote with AI branch naming (lines 1360-1416)
  - Checks for uncommitted changes
  - Auto-commits if needed
  - Renames branch with AI if enabled
  - Pushes to remote
- `P` (Shift+P) - Create draft PR (lines 1418-1496)
  - Auto-commits changes with AI if enabled
  - Generates AI branch name if enabled
  - Generates AI PR title/description if enabled
  - Creates draft PR via gh CLI
  - Stores PR URL in config
- `u` - Update from base branch (lines 1342-1358)
  - Fetches latest changes from remote
  - Merges base branch into worktree
  - Handles merge conflicts gracefully
  - Only on workspace branches (safety check)

**Pull Requests**:
- `N` (Shift+N) - Create worktree from GitHub PR (lines 1498-1506)
  - Lists all open PRs with search/filter
  - Creates worktree from selected PR branch
- `v` - View PR in browser (lines 1548-1569)
  - Opens PR URL in default browser via gh CLI
  - Supports multiple PRs per branch with selection modal
- `M` (Shift+M) - Merge PR (lines 1571-1591)
  - Strategy selection: squash, merge commit, or rebase
  - Merges via gh CLI
- `g` - Open git repository in browser (lines 1250-1256)
  - Opens repo URL in default browser

**Session Management**:
- `enter` - Switch to selected worktree with Claude session (lines 1197-1227)
  - Creates or attaches to Claude session
  - Session name format: `gcool-<sanitized-branch>`
  - First run uses `claude`, subsequent runs use `claude --continue`
  - Tracks initialization in config
- `t` - Open terminal session (lines 1268-1289)
  - Creates or attaches to terminal-only session
  - Session name format: `gcool-<sanitized-branch>-terminal`
  - Both Claude and terminal sessions can coexist
- `S` (Shift+S) - View/manage tmux sessions (lines 1323-1328)
  - Lists all active sessions with kill option

**Application**:
- `e` - Select/change default editor (lines 1298-1314)
  - Opens editor selection modal
  - 7 editors available: code, cursor, nvim, vim, subl, atom, zed
- `s` - Open settings menu (lines 1316-1321)
  - Access: Editor, Base Branch, Tmux Config, AI Settings, Debug Logs, Theme
- `h` - Show help modal (lines 1593-1596)
  - Displays comprehensive keybinding reference

### Modal Keybindings

All modals support:
- `esc` - Close modal without action
- `enter` - Confirm action
- `tab` - Navigate between inputs/options (where applicable)

**Specific modals in `tui/update.go`**:
- `createWithNameModalInput()` (lines 511-577) - Create worktree with custom name
  - Type to set branch/session name
  - Pre-filled with random suggestion
  - Shows sanitized name preview
- `handleDeleteModalInput()` - Deletion confirmation
- `handleBranchSelectModalInput()` - Branch selection with search/filter
  - Type to filter in real-time
  - Navigate with ↑/↓, Tab between search and list
- `handleCheckoutBranchModalInput()` - Checkout modal with search/filter
- `handleSessionListModalInput()` - Session list
  - ↑/↓ to navigate
  - `d` or `k` to kill selected session
- `handleRenameModalInput()` - Branch rename
  - Text input with main branch protection
- `handleChangeBaseBranchModalInput()` - Base branch modal with search/filter
- `handleCommitModalInput()` - Commit modal
  - Tab cycles: subject → body → commit button → cancel button
  - Enter in inputs moves to next field
- `handleEditorSelectModalInput()` - Editor selection (↑/↓ navigate)
- `handleSettingsModalInput()` - Settings menu (↑/↓ navigate)
- `handleTmuxConfigModalInput()` - Tmux config install/update/remove
- `handlePRContentModalInput()` (lines 592-627) - Manual PR title/description
  - Tab to cycle between title, description, and buttons
- `handlePRListModalInput()` (lines 1257-1372) - Browse/filter PRs
  - Type to search by title, author, or branch
  - ↑/↓ to navigate paginated list
- `handleMergeStrategyModalInput()` (lines 2129-2174) - Merge strategy selection
  - ↑/↓ navigate (squash, merge, rebase)
- `handleScriptsModalInput()` - Scripts management
  - ↑/↓ navigate running/available scripts
  - `d` or `k` to kill running scripts
  - `enter` to run selected script
- `handleScriptOutputModalInput()` (lines 2058-2126) - Real-time script output
  - `k` or `enter` to kill/close
- `handleThemeSelectModalInput()` (lines 1410-1441) - Theme selection
  - ↑/↓ navigate between 5 themes
- `handleHelpModalInput()` (lines 1778-1939) - Help reference
  - Shows all keybindings by category

## Common Patterns

### Adding a New Keybinding

**Example: Adding "o" to open workspace in editor**

1. **Add message type** in `tui/model.go`:
```go
type editorOpenedMsg struct {
    err error
}
```

2. **Add keybinding** in `tui/update.go` in `handleMainInput()`:
```go
case "o":
    if wt := m.selectedWorktree(); wt != nil {
        return m, m.openInEditor(wt.Path)
    }
```

3. **Create command function** in `tui/model.go`:
```go
func (m Model) openInEditor(path string) tea.Cmd {
    return func() tea.Msg {
        editor := os.Getenv("EDITOR")
        if editor == "" {
            editor = "code"  // fallback
        }
        cmd := exec.Command(editor, path)
        err := cmd.Start()
        return editorOpenedMsg{err: err}
    }
}
```

4. **Handle message** in `tui/update.go` in `Update()`:
```go
case editorOpenedMsg:
    if msg.err != nil {
        m.status = "Failed to open editor"
    } else {
        m.status = "Opened in editor"
    }
    return m, nil
```

5. **Update help bar** in `tui/view.go` in `renderHelpBar()`:
```go
row1 := []string{
    "↑/↓ navigate",
    "o open editor",  // Add this
    // ... rest
}
```

### Adding a New Git Operation

1. Add method to `git.Manager` in `git/worktree.go`
2. Create a Tea command function in `tui/model.go` that calls the git method
3. Define a message type for the result
4. Handle the message in `tui/update.go`
5. Update the view in `tui/view.go` if needed

### Adding a New Modal

1. Add new `modalType` constant in `tui/model.go`
2. Add modal state fields to `Model` struct
3. Add keybinding to open modal in `tui/update.go`
4. Implement modal rendering in `tui/view.go`
5. Handle modal interactions (Tab, Enter, Esc) in `tui/update.go`

### Message Flow Pattern

Async operations in gcool follow this pattern:

1. **User Action** → Keybinding triggers command
2. **Command Function** → Returns `tea.Cmd` that executes async operation
3. **Operation Result** → Wrapped in typed message (e.g., `worktreeCreatedMsg`)
4. **Update Handler** → Receives message, updates model state
5. **View Render** → UI reflects new state

Example flow for creating worktree:
```
User presses 'n'
  → handleMainInput() opens createModal
  → User enters branch name and presses Enter
  → handleCreateModalInput() calls createWorktree() command
  → createWorktree() runs git operations asynchronously
  → Returns worktreeCreatedMsg with result
  → Update() handles worktreeCreatedMsg
  → Updates worktree list and closes modal
  → View() renders updated list
```

### Error Handling

Errors from async operations are stored in `model.err` and displayed in the status bar at the bottom of the UI. The status bar shows:
- Success messages (e.g., "Worktree created")
- Error messages (e.g., "Failed to create worktree: ...")
- Current operation status
