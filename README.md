# gcool - A Cool TUI for Git Worktrees & Running CLI-Based AI Assistants Simultaneously

A beautiful terminal user interface for managing Git worktrees with integrated tmux session management, built with [Bubble Tea](https://github.com/charmbracelet/bubbletea). Run multiple Claude CLI sessions across different branches effortlessly.

## Features

- **Full CRUD Operations**: Create, list, switch, and delete worktrees
- **Tmux Session Management**: Persistent Claude CLI sessions per worktree
- **Auto-Generated Names**: Random branch and workspace names pre-filled (editable)
- **Organized Workspaces**: All worktrees are created in `.workspaces/` directory
- **Fun Naming**: Names like `happy-panda-42`, `swift-dragon-17`, `brave-falcon-89`
- **Session Persistence**: Detach and return to your work anytime
- **Intuitive Panels UI**: Split-panel interface showing worktrees and detailed information
- **Create from New or Existing Branches**: Choose to create a new branch or use an existing one
- **Shell Integration**: Seamlessly switch directories using shell wrappers
- **Keyboard-First**: Vim-style navigation and shortcuts
- **Beautiful Styling**: Colorful, modern terminal UI using Lipgloss

## Installation

### Using Go Install

```bash
go install github.com/coollabsio/gcool@latest
```

### From Source

```bash
git clone https://github.com/coollabsio/gcool
cd gcool
go build -o gcool
sudo mv gcool /usr/local/bin/
```

## Platform Support

### Supported Platforms

- **Linux** ✅ Full support
- **macOS** ✅ Full support
- **Windows** ⚠️ WSL2 required (see below)

### Windows Users

gcool requires **WSL2 (Windows Subsystem for Linux 2)** to run on Windows because it depends on:
- **tmux** - Terminal multiplexer (Unix/Linux only)
- **bash/zsh/fish** - POSIX shells (not available on native Windows)

**To use gcool on Windows:**

1. Install WSL2: https://docs.microsoft.com/en-us/windows/wsl/install
2. Inside WSL2, install gcool normally (see Installation section below)
3. Use gcool from within your WSL2 terminal

If you try to run gcool on native Windows (not WSL2), you'll see an error message with installation instructions for WSL2.

## Prerequisites

- **tmux**: Required for persistent session management
  ```bash
  # macOS
  brew install tmux

  # Ubuntu/Debian
  sudo apt install tmux

  # Arch
  sudo pacman -S tmux
  ```

## Shell Integration Setup

The shell wrapper enables:
1. Automatic tmux session creation/attachment
2. Claude CLI auto-start in each worktree
3. Session persistence (detach with `Ctrl+B D`, return anytime)

### Quick Setup (One Command)

Simply run:

```bash
gcool init
```

This will:
- Auto-detect your shell (bash, zsh, fish)
- Install the wrapper to your shell configuration file
- Create a backup of your config file
- Provide instructions for activating the changes

After installation, restart your terminal or run:
```bash
source ~/.bashrc   # for bash
source ~/.zshrc    # for zsh
# or restart fish
```

### Updating the Installation

If you already have gcool installed and want to update to the latest wrapper:

```bash
gcool init --update
```

### Removing the Integration

To cleanly remove gcool from your shell configuration:

```bash
gcool init --remove
```

### Manual Installation (Optional)

If you prefer to set up the wrapper manually or have a shell not supported by `gcool init`, you can view the wrapper functions embedded in `install/templates.go`:

- **BashZshWrapper** constant: Bash/Zsh shell wrapper
- **FishWrapper** constant: Fish shell wrapper

These templates are automatically compiled into the gcool binary and deployed by `gcool init`.

## Usage

### Basic Usage

Run `gcool` in any Git repository:

```bash
cd /path/to/your/repo
gcool
```

### With Custom Path (for Development)

Test on a different repository without navigating to it:

```bash
gcool -path /path/to/other/repo
```

## Keybindings

### Main View - Navigation
- `↑` - Move cursor up in worktree list
- `↓` - Move cursor down in worktree list
- `Enter` - Switch to selected worktree (with Claude)
- `t` - Open terminal in worktree (without Claude)

### Main View - Worktree Management
- `n` - Create new worktree with a **new branch** (random name, selects but doesn't auto-switch)
- `a` - Create worktree from an **existing branch**
- `d` - Delete selected worktree
- `r` - Refresh worktree list (fetch from remote)
- `R` (Shift+R) - Run 'run' script on selected worktree
- `;` - Open scripts modal

### Main View - Branch Operations
- `B` (Shift+B) - Rename current branch
- `K` (Shift+K) - Checkout/switch branch in main repository
- `b` - Change base branch for new worktrees
- `c` - Commit all uncommitted changes
- `p` - Push to remote (with AI branch naming)
- `P` (Shift+P) - Push & create draft PR
- `u` - Update from base branch (pull/merge)
- `v` - Open PR in browser

### Main View - Application
- `e` - Select default editor
- `h` - Show help modal
- `s` - Open settings menu
- `S` (Shift+S) - View/manage tmux sessions
- `o` - Open worktree in configured editor
- `q` / `Ctrl+C` - Quit application

### Modal Navigation (All Modals)
- `Tab` - Cycle through inputs/buttons
- `Enter` - Confirm action
- `Esc` - Cancel/close modal

### Session List Modal (Press `S` - Shift+S)
- `↑` / `↓` - Navigate through sessions
- `Enter` - Attach to selected session
- `d` - Kill selected session
- `Esc` / `q` - Close modal

### Branch Selection Modals (Press `a`, `K`, or `b`)
- Type to filter branches by name
- `↑` / `↓` - Navigate through filtered branch list
- `Tab` - Cycle between search input, list, and buttons
- `Enter` - Select branch
- `Esc` - Cancel

### Settings Modal (Press `s`)
- `↑` / `↓` - Navigate through settings options
- `Enter` - Configure selected setting
- `Esc` / `q` - Close modal

### Editor Selection Modal (Press `e` or via settings)
- `↑` / `↓` - Navigate through available editors
- `Enter` - Select and save editor preference
- `Esc` - Cancel

## How It Works

All worktrees are created inside a `.workspaces/` directory in your repository root with randomly generated names like:
- `happy-panda-42`
- `swift-dragon-17`
- `brave-falcon-89`

This keeps your workspace organized and makes it easy to manage multiple feature branches without cluttering your file system.

## Tmux Sessions & Claude CLI

When you switch to a worktree, `gcool` creates separate sessions for different purposes:

1. **Claude sessions** (`Enter` key): Named `gcool-<branch-name>`, includes Claude CLI
2. **Terminal sessions** (`t` key): Named `gcool-<branch-name>-terminal`, shell only
3. **Both sessions can coexist** for the same worktree
4. **Persists your work** - detach anytime with `Ctrl+B D`

You can have both a Claude session and a terminal session open for the same worktree and switch between them as needed.

### Session Management

**View all sessions**: Press `S` (Shift+S) in the TUI to see active sessions

**Switching between sessions**:
1. Open a terminal session with `t` (creates `gcool-<branch>-terminal`)
2. Work in the terminal, then press `Ctrl+B D` to detach
3. You'll automatically return to gcool
4. Press `Enter` to open the Claude session (creates `gcool-<branch>`)
5. Now you have both sessions running simultaneously
6. You can continue detaching and switching between sessions

**Manual session control**:
```bash
# List all gcool sessions
tmux ls | grep gcool-

# Attach to a specific Claude session
tmux attach -t gcool-feature-auth

# Attach to a specific terminal session
tmux attach -t gcool-feature-auth-terminal

# Kill a session
tmux kill-session -t gcool-feature-auth
# or
tmux kill-session -t gcool-feature-auth-terminal
```

**Detach from session**: `Ctrl+B D` (tmux default)

**Disable auto-Claude**: Use the `--no-claude` flag
```bash
gcool --no-claude
```

### How Sessions Work

```
┌─────────────────────────────────────────────────────────────┐
│  You: gcool (select "feature-auth")                          │
├─────────────────────────────────────────────────────────────┤
│  Press Enter → Claude session "gcool-feature-auth"           │
│  ├─ Exists? → Attach to existing Claude session            │
│  └─ New? → Create session + start Claude CLI               │
│                                                              │
│  Press t → Terminal session "gcool-feature-auth-terminal"   │
│  ├─ Exists? → Attach to existing terminal session          │
│  └─ New? → Create session with shell only                  │
└─────────────────────────────────────────────────────────────┘
```

**Benefits**:
- Each worktree can have TWO separate sessions (Claude + terminal)
- Work persists across terminal restarts
- Context is maintained per branch
- Easy to switch between multiple features
- Flexibility to use Claude or terminal as needed

## UI Overview

```
┌──────────────────────────────┬──────────────────────────────┐
│  📁 Worktrees                │  ℹ️  Details                  │
│                              │                              │
│  ➜ main (current)            │  Branch: main                │
│     └─ my-repo               │  Path: /path/to/my-repo      │
│                              │  Commit: abc1234             │
│  › feature-branch            │  Status: Available           │
│     └─ happy-panda-42        │                              │
│                              │  Press Enter to switch       │
│  bug-fix                     │                              │
│     └─ swift-dragon-17       │                              │
│                              │                              │
└──────────────────────────────┴──────────────────────────────┘
 ↑/↓ navigate • n new • a existing • d delete • enter switch • q quit
```

## Workflow Examples

### Create a New Worktree with a New Branch

1. Press `n` to instantly create a worktree with a random branch name (e.g., `happy-panda-42`)
2. The worktree is created in `.workspaces/` with another random name
3. The newly created worktree is automatically selected in the list
4. Press `Enter` to switch to it and open Claude session when ready

### Create a Worktree from an Existing Branch

1. Press `a` to open the branch selection modal
2. Navigate with `↑`/`↓` to select a branch
3. Press `Enter` to confirm
4. Worktree is created instantly with a random name

### Switch to a Worktree

1. Navigate to the desired worktree with `↑`/`↓`
2. Press `Enter` to switch with Claude session, or `t` for terminal only
3. Your shell will automatically `cd` to that worktree and open the session

### Delete a Worktree

1. Navigate to the worktree you want to delete
2. Press `d`
3. Confirm deletion in the modal
4. The worktree directory will be removed

## Development

### Prerequisites

- **Go 1.21+**: For building and development
- **Git**: Required for all worktree operations
- **tmux**: Required for session management

### Development Commands

```bash
# Run locally
go run main.go

# Run with custom repository path (for testing)
go run main.go -path /path/to/test/repo

# Build binary
go build -o gcool

# Install to system
sudo cp gcool /usr/local/bin/

# Initialize/update dependencies
go mod tidy

# Verify the build
go build -o gcool

# Test with different flags
./gcool --version
./gcool --help
./gcool --no-claude
```

### Project Structure

For detailed codebase documentation, architecture patterns, and development guidelines, see [CLAUDE.md](./CLAUDE.md).

Key areas documented in CLAUDE.md:
- Complete keybinding reference with implementation locations
- Adding new features (keybindings, git operations, modals)
- Message flow and async operation patterns
- File structure with line number references
- Extension points and future enhancements

### Adding New Features

See [CLAUDE.md](./CLAUDE.md) for detailed guides on:
- **Adding a new keybinding**: Step-by-step with code examples
- **Adding a new git operation**: Pattern for extending git functionality
- **Adding a new modal**: Pattern for creating modal dialogs
- **Message flow pattern**: Understanding async operations

## Configuration

### Settings Menu

Press `s` to open the settings menu, where you can configure:

1. **Editor** - Default editor for opening worktrees
   - Press `Enter` on this option to select from available editors
   - Editors: code, cursor, nvim, vim, subl, atom, zed
   - Default: VS Code (`code`)

2. **Base Branch** - Base branch for creating new worktrees
   - Press `Enter` to select from available branches
   - Used when creating new branches with `n` key

3. **Tmux Config** - Install/update/remove opinionated tmux configuration
   - Press `Enter` to manage gcool's tmux config in `~/.tmux.conf`
   - Adds mouse support, better scrollback, Ctrl-D detach, and more
   - Config is clearly marked and can be safely removed anytime

All settings are saved per-repository in `~/.config/gcool/config.json`:

```json
{
  "repositories": {
    "/path/to/repo": {
      "base_branch": "main",
      "editor": "code"
    }
  }
}
```

### Tmux Configuration

gcool provides an opinionated tmux configuration that can be optionally installed to enhance your terminal experience.

**Installing the config:**
1. Press `s` to open the settings menu
2. Navigate to "Tmux Config" and press `Enter`
3. Press `Enter` on "Install Config" button
4. The config will be appended to your `~/.tmux.conf` in a clearly marked section

**Features included:**
- **Mouse scrolling enabled** - Scroll with your mouse wheel like a normal terminal
- **10,000 line scrollback buffer** - More history to scroll through
- **256 color support** - Better colors and styling
- **Ctrl-D to detach** - Quick detach with `Ctrl+D` instead of `Ctrl+B D`
- **Better status bar** - Minimal design with gcool branding
- **Nice pane border colors** - Visual improvements

**Managing the config:**
- **Update**: If gcool adds new features, use the "Update Config" button to get the latest
- **Remove**: Use the "Remove Config" button to cleanly remove the gcool section
- **Manual edit**: The config is marked with unique identifiers - you can manually delete it anytime

**Important notes:**
- Your existing `~/.tmux.conf` settings are preserved
- Changes apply to new tmux sessions only (existing sessions are unaffected)
- The config section has warning markers - don't modify them as they're used for updates
- You can safely delete the entire marked section if you no longer want it

### Base Branch

The base branch is used when creating new worktrees with new branches. gcool automatically determines the base branch:

1. Check saved config for repository
2. Fall back to current branch
3. Fall back to default branch (main/master)
4. Fall back to empty string (user must set manually with `c` key)

You can change the base branch at any time by pressing `c` in the main view.

### Editor Integration

gcool includes built-in editor integration for opening worktrees in your IDE with a single keypress.

**Setting your preferred editor:**
1. Press `e` in the main view (or access via settings menu with `s`)
2. Use `↑`/`↓` or `j`/`k` to navigate through available editors
3. Press `Enter` to select and save your preference

**Available editors:**
- `code` - VS Code (default)
- `cursor` - Cursor IDE
- `nvim` - Neovim
- `vim` - Vim
- `subl` - Sublime Text
- `atom` - Atom
- `zed` - Zed

**Opening a worktree:**
- Navigate to any worktree in the list
- Press `o` to open it in your configured editor
- The editor launches in the background and you stay in gcool
- Editor preference is saved per repository in `~/.config/gcool/config.json`

**Tips:**
- If opening fails, press `e` to select a different editor
- Each repository can have its own editor preference
- The editor command must be in your PATH

## Architecture

### Directory Structure

```
gcool/
├── main.go              # CLI entry point, handles flags and shell integration
├── CLAUDE.md            # Development guide and codebase documentation
├── go.mod               # Module: github.com/coollabsio/gcool
├── config/              # Configuration management
│   └── config.go        # Manages ~/.config/gcool/config.json
├── git/                 # Git operations wrapper
│   └── worktree.go      # Worktree CRUD, branch management, random names
├── session/             # Tmux session management
│   └── tmux.go          # Session creation, attachment, listing, cleanup
├── tui/                 # Bubble Tea TUI (Elm Architecture / MVC)
│   ├── model.go         # State management, data structures, Tea commands
│   ├── update.go        # Event handling, keybindings, state transitions
│   ├── view.go          # UI rendering, modal renderers
│   └── styles.go        # Lipgloss styling definitions
└── install/             # Installation and shell wrapper templates
    └── templates.go     # Shell wrapper templates (BashZshWrapper, FishWrapper)
```

### Key Architectural Patterns

**Bubble Tea MVC**: The TUI follows the Elm Architecture pattern via Bubble Tea:
- **Model**: Holds all application state (worktrees, branches, sessions, UI state, modals)
- **Update**: Handles messages (keyboard input, async operation results)
- **View**: Renders the UI based on current model state

**Async Operations**: Git and tmux operations are wrapped in Tea commands:
- Operations run asynchronously and return typed messages
- Results are handled in the Update function to update state
- Examples: `worktreesLoadedMsg`, `worktreeCreatedMsg`, `branchRenamedMsg`

**Modal System**: The TUI uses a modal system for different operations:
- Create worktree, delete confirmation, branch selection, session list, rename branch, change base branch
- All modals support Tab navigation, Enter to confirm, Esc to cancel

**Shell Integration Protocol**: Communication with shell wrappers via:
- `GCOOL_SWITCH_FILE` environment variable (preferred): Write switch data to file
- Stdout (legacy): Print switch data in format `path|branch|auto-claude|terminal-only`

**Worktree Organization**: All worktrees are created in `.workspaces/` directory at repository root with randomly generated names (adjective-noun-number pattern)

## Dependencies

- [Bubble Tea](https://github.com/charmbracelet/bubbletea) - TUI framework
- [Lipgloss](https://github.com/charmbracelet/lipgloss) - Terminal styling
- [Bubbles](https://github.com/charmbracelet/bubbles) - TUI components

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Acknowledgments

- Inspired by [git-worktree-tui](https://github.com/FredrikMWold/git-worktree-tui)
- Built with the amazing [Charm](https://charm.sh/) ecosystem
