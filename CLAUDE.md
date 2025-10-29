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
- **git/**: Git worktree operations wrapper
  - `worktree.go`: All git worktree CRUD operations, branch management, and random name generation
- **session/**: Tmux session management
  - `tmux.go`: Session creation, attachment, listing, and lifecycle management
- **config/**: User configuration persistence
  - `config.go`: Manages base branch settings per repository in `~/.config/gcool/config.json`
- **shell/**: Shell integration wrappers for bash/zsh/fish

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
- Stores per-repository settings: base branch, editor preference, last selected branch
- JSON structure:
```json
{
  "repositories": {
    "<repo-path>": {
      "base_branch": "main",
      "editor": "code",
      "last_selected_branch": "feature/my-branch"
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

## Dependencies

Key external dependencies:
- `github.com/charmbracelet/bubbletea`: TUI framework
- `github.com/charmbracelet/lipgloss`: Terminal styling
- `github.com/charmbracelet/bubbles`: TUI components (textinput)

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

All keybindings are defined in `tui/update.go`. The application uses Bubble Tea's native `tea.KeyMsg` system with string-based matching.

### Main View Keybindings (tui/update.go:150-262)

**Navigation**:
- `↑`, `k` - Move cursor up
- `↓`, `j` - Move cursor down
- `enter` - Switch to selected worktree (with Claude)
- `t` - Open terminal in worktree (without Claude)

**Worktree Management**:
- `n` - Create new worktree with random branch name (selects it but doesn't switch)
- `a` - Create worktree from existing branch
- `d` - Delete selected worktree
- `r` - Refresh worktree list

**Branch Operations**:
- `R` (Shift+R) - Rename current branch
- `K` (Shift+K) - Checkout/switch branch in main repository
- `b` - Change base branch for new worktrees
- `C` (Shift+C) - Commit all uncommitted changes (opens commit modal)
- `P` (Shift+P) - Pull changes from base branch (only when behind) ⚠️ NOT YET TESTED
- `p` (lowercase) - Create draft PR

**Application**:
- `q`, `ctrl+c` - Quit application
- `s` - Open settings menu
- `S` (Shift+S) - View/manage tmux sessions
- `e` - Select/change default editor
- `o` - Open worktree in configured editor

### Modal Keybindings

All modals support:
- `esc` - Close modal without action
- `enter` - Confirm action
- `tab` - Navigate between inputs/options (where applicable)

Specific modal handlers are implemented in `tui/update.go`:
- `handleCreateModalInput()` - Create worktree modal
- `handleDeleteModalInput()` - Deletion confirmation
- `handleBranchSelectModalInput()` - Branch selection with search/filter (supports typing to filter)
- `handleCheckoutBranchModalInput()` - Checkout modal with search/filter
- `handleSessionListModalInput()` - Session list (uses `↑`/`↓`, `k` to kill sessions)
- `handleRenameModalInput()` - Branch rename modal (text input, prevents renaming main branch)
- `handleChangeBaseBranchModalInput()` - Base branch modal with search/filter
- `handleCommitModalInput()` - Commit modal (subject + optional body, Tab to cycle, Enter to move/confirm)
- `handleEditorSelectModalInput()` - Editor selection modal (uses `↑`/`↓` navigation)
- `handleSettingsModalInput()` - Settings menu navigation
- `handleTmuxConfigModalInput()` - Tmux config install/update/remove

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
