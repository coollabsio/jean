# gcool - AI-Powered Git Worktree Management & Development Workflow Automation

A powerful, feature-rich terminal user interface for managing Git worktrees with integrated tmux session management, GitHub PR automation, AI-powered commit messages & branch naming, and custom script execution. Built with [Bubble Tea](https://github.com/charmbracelet/bubbletea) and designed for developers who work with multiple feature branches simultaneously while leveraging AI to streamline their workflow.

## Features

### Core Worktree Management
- **Full CRUD Operations**: Create, list, switch, and delete worktrees with single keystrokes
- **Organized Workspaces**: All worktrees created in `.workspaces/` directory with auto-generated names (`happy-panda-42`, `swift-dragon-17`, etc.)
- **Create from New or Existing Branches**: Choose to create a new branch (`n`) or attach to existing (`a`)
- **Session Persistence**: Detach and return to your work anytime - context persists across terminal restarts
- **Automatic Sorting**: Worktrees sorted by last modified time (most recent first)
- **Dual Session Mode**: Run both Claude AI and terminal sessions simultaneously on the same worktree

### AI-Powered Workflow
- **AI Commit Messages**: Automatically generate conventional commit messages from your changes using 11+ AI models (GPT-4, Claude, Gemini, etc.)
- **AI Branch Naming**: Generate semantic branch names from code changes (e.g., `feat/user-authentication`, `fix/button-alignment`)
- **AI PR Content**: Auto-generate PR titles and descriptions from your git diff
- **OpenRouter Integration**: Switch between multiple AI models on the fly (GPT-4 Turbo, Claude 3 Opus, Gemini Pro, Llama 2, and more)
- **Configurable AI Settings**: Toggle AI features per repository, manage API keys securely

### GitHub PR Automation
- **Create Draft PRs**: Auto-commit, rename branches with AI, generate PR content, and create draft PRs in one command (`P`)
- **Create Worktree from PR**: Browse and filter GitHub PRs, create worktrees from PR branches instantly (`N`)
- **View PRs in Browser**: Open PR links with clickable terminal hyperlinks (`v`)
- **Merge with Strategy Selection**: Merge with squash, merge commit, or rebase options (`M`)
- **PR Status Tracking**: See PR status directly in the worktree details panel

### Git Operations
- **Smart Push**: Push to remote with auto-commit and AI-powered branch naming (`p`)
- **Refresh with Auto-Pull**: Fetch from remote and pull all worktrees in one command, skip branches with uncommitted changes (`r`)
- **Update from Base**: Pull/merge base branch changes into your worktree (`u`)
- **Branch Management**: Rename branches (`B`), checkout branches (`K`), change base branch (`b`)
- **Merge Conflict Handling**: Gracefully handle merge conflicts with abort option

### Custom Scripts & Automation
- **Custom Script Execution**: Define and run bash scripts from `gcool.json` on any worktree (`R`, `;`)
- **Real-time Output Streaming**: Watch script execution with live output updates
- **Script Management**: View running scripts, kill scripts mid-execution, check status and elapsed time
- **Setup Automation**: Auto-execute setup scripts when creating new worktrees
- **Environment Variables**: Access `GCOOL_WORKSPACE_PATH`, `GCOOL_ROOT_PATH`, `GCOOL_BRANCH` in your scripts

### UI & Customization
- **5 Built-in Themes**: Matrix, Coolify, Dracula, Nord, Solarized - choose your aesthetic
- **Dynamic Theme Switching**: Change themes without restarting the app
- **Intuitive Split-Panel UI**: Worktree list on left, detailed information and status on right
- **Real-time Claude Status**: See when Claude is thinking/ready with animated spinners and indicators
- **Comprehensive Help Modal**: Press `h` to see all keybindings and features
- **Keyboard-First Design**: Vim-style navigation (hjkl, arrow keys) - no mouse required
- **Beautiful Terminal Styling**: Modern UI with Lipgloss and Charm styling

### Developer Experience
- **Shell Integration**: Seamlessly switch directories and attach to sessions via shell wrappers
- **Multi-editor Support**: Open worktrees in VS Code, Cursor, Neovim, Vim, Sublime, Atom, or Zed (`o`)
- **Configurable Settings**: Per-repository settings for editor, base branch, AI models, themes
- **Debug Logging**: Enable debug logs for troubleshooting (`s` → Debug Logs)
- **Configuration Files**:
  - `~/.config/gcool/config.json` - User configuration
  - `gcool.json` - Per-repository scripts and settings
- **Tmux Configuration Management**: Install/update/remove optimized tmux config from the app

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

All keybindings are designed to be fast and intuitive. Most operations are single keystrokes. Here's the complete reference:

### Main View - Navigation
| Key | Action |
|-----|--------|
| `↑` / `up` / `k` | Move cursor up in worktree list |
| `↓` / `down` / `j` | Move cursor down in worktree list |
| `q` / `Ctrl+C` | Quit gcool |
| `h` | Show comprehensive help modal with all keybindings |

### Main View - Worktree Management
| Key | Action |
|-----|--------|
| `Enter` | Switch to selected worktree (opens Claude session) |
| `t` | Open terminal session in selected worktree (without Claude) |
| `n` | Create new worktree with new random branch name (customizable) |
| `a` | Create worktree from existing branch (searchable) |
| `d` | Delete selected worktree (with confirmation) |
| `o` | Open worktree in configured editor (code, nvim, vim, etc.) |
| `r` | Refresh: fetch from remote and auto-pull all branches |
| `R` (Shift+R) | Run 'run' script from `gcool.json` with live output |
| `;` | Open scripts modal to run custom scripts |

### Main View - Git & Branch Operations
| Key | Action |
|-----|--------|
| `b` | Change base branch for new worktrees |
| `B` (Shift+B) | Rename current branch (protected from renaming main) |
| `K` (Shift+K) | Checkout/switch branch in main repository |
| `c` | Commit changes with AI-generated messages (if enabled) |
| `p` | Push to remote with smart branch naming and auto-commit |
| `u` | Update from base branch (fetch + merge, handles conflicts) |
| `g` | Open repository in browser |

### Main View - GitHub PR Operations
| Key | Action |
|-----|--------|
| `P` (Shift+P) | Create draft PR with AI-generated title/description |
| `N` (Shift+N) | Create worktree from existing GitHub PR |
| `v` | Open PR in browser (clickable terminal links) |
| `M` (Shift+M) | Merge PR (choose: squash/merge/rebase) |

### Main View - Application & Settings
| Key | Action |
|-----|--------|
| `e` | Select/change default editor |
| `s` | Open settings menu (editor, base branch, themes, AI, tmux config, debug logs) |
| `S` (Shift+S) | View and manage all active tmux sessions |

### Modal Navigation (All Modals)
| Key | Action |
|-----|--------|
| `Tab` | Cycle through inputs, lists, and buttons |
| `Enter` | Confirm action or move to next field |
| `Esc` / `q` | Close modal without action |

### Modal-Specific Keybindings

**Branch Selection Modals** (Press `a`, `K`, `b`):
- Type to filter branches in real-time
- `↑` / `↓` - Navigate filtered results
- `Tab` - Move focus (search → list → buttons)
- `Enter` - Select branch

**PR List Modal** (Press `N`):
- Type to search by title, author, or branch name
- `↑` / `↓` - Navigate PRs (paginated)
- `Enter` - Create worktree from selected PR

**Commit Modal** (Press `c`):
- Tab cycles: subject input → body input → commit button → cancel button
- `Enter` in input fields moves to next field
- Auto-generates commit message with AI if enabled

**Scripts Modal** (Press `;`):
- `↑` / `↓` - Navigate between scripts
- `d` / `k` - Kill running scripts
- `Enter` - Run selected script

**Session List Modal** (Press `S`):
- `↑` / `↓` - Navigate sessions
- `d` / `k` - Kill selected session
- `Enter` - Attach to selected session

**Settings Modal** (Press `s`):
- `↑` / `↓` - Navigate options
- `Enter` - Configure selected setting (editor, base branch, theme, etc.)

**Theme Selection Modal** (Press `s` → Theme):
- `↑` / `↓` - Navigate between 5 themes
- `Enter` - Apply selected theme
- Preview theme info before selecting

**Merge Strategy Modal** (Press `M`):
- `↑` / `↓` - Choose: squash, merge commit, or rebase
- `Enter` - Confirm merge strategy

**Editor Selection Modal** (Press `e` or via settings):
- `↑` / `↓` - Navigate available editors
- `Enter` - Select and save preference

### Quick Reference Cheat Sheet

```
NAVIGATION         WORKTREE OPS       GIT OPS           PR WORKFLOW       APPLICATION
─────────────────  ─────────────────  ────────────────  ────────────────  ────────────────
↑/↓ navigate       n new branch       b set base        P create PR       e select editor
Enter attach       a exist branch     B rename          N from PR         s settings
t terminal         d delete           K checkout        v view PR         S sessions
q quit             r refresh          c commit          M merge PR        h help
                   R run script       u update          g open repo
                   ; scripts          p push
```

## Advanced Features

### AI-Powered Workflow

**Automatic Commit Messages**:
```
Press 'c' to commit with AI-generated messages:
1. AI analyzes your git diff
2. Generates conventional commit message (feat/fix/docs/etc.)
3. You review and can edit before committing
4. Commit is created with generated message

Supports 11+ AI models (GPT-4, Claude, Gemini, Llama, etc.)
```

**Semantic Branch Naming**:
```
When creating PRs or pushing:
1. AI analyzes your code changes
2. Generates meaningful branch names (feat/fix/refactor/etc.)
3. Replaces random names with semantic convention
4. Can be toggled on/off in AI Settings
```

### GitHub PR Workflow (Single Command)

```
Press 'P' to:
1. Auto-commit any uncommitted changes
2. Rename branch with AI (optional)
3. Generate PR title/description with AI (optional)
4. Push to remote
5. Create draft PR
6. Store PR URL for future reference

Everything in one keystroke!
```

### Custom Scripts System

Define scripts in `gcool.json`:
```json
{
  "scripts": {
    "run": "npm start",
    "test": "npm test",
    "build": "npm run build",
    "deploy": "npm run build && ./deploy.sh"
  }
}
```

Run with `R` (quick 'run' script) or `;` (scripts menu) with:
- Real-time output streaming
- Script execution status and elapsed time
- Kill running scripts mid-execution
- Setup scripts run automatically on worktree creation

### Multi-Model AI Integration

Switch between AI models per repository:
- OpenAI: GPT-4 Turbo, GPT-4, GPT-3.5
- Anthropic: Claude 3 Opus, Sonnet, Haiku
- Google: Gemini Pro
- Meta: Llama 2
- Mistral: Mistral 7B
- And more via OpenRouter API

API keys stored securely in local config (`~/.config/gcool/config.json`).

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

### AI Setup

**Enable AI Features**:
1. Press `s` to open settings
2. Navigate to "AI Settings" and press `Enter`
3. Enter your OpenRouter API key (get one at https://openrouter.ai)
4. Select preferred AI model (GPT-4 recommended for best results)
5. Toggle AI commit messages and AI branch naming on/off
6. (Optional) Test API key to verify configuration

**API Key Security**:
- Keys stored locally in `~/.config/gcool/config.json`
- Per-repository configuration (different keys for different repos)
- Never transmitted except to OpenRouter API
- Can be revoked anytime from OpenRouter dashboard

### Custom Scripts (gcool.json)

Create a `gcool.json` file in your repository root to define custom scripts:

```json
{
  "scripts": {
    "run": "npm start",
    "test": "npm test",
    "build": "npm run build && npm run lint",
    "deploy": "npm run build && ./scripts/deploy.sh",
    "watch": "npm run dev",
    "lint": "eslint src/"
  }
}
```

**Available Environment Variables in Scripts**:
- `GCOOL_WORKSPACE_PATH` - Full path to the worktree
- `GCOOL_ROOT_PATH` - Full path to repository root
- `GCOOL_BRANCH` - Current branch name

**Example Script**:
```bash
#!/bin/bash
cd "$GCOOL_WORKSPACE_PATH"
npm install
cp "$GCOOL_ROOT_PATH/.env.local" .env
npm test
```

**Running Scripts**:
- Press `R` - Run 'run' script with output modal
- Press `;` - Open scripts modal to select and run any script
- Press `d` or `k` while script runs to kill it
- Real-time output streaming (updated every 200ms)

### Settings Menu

Press `s` to open the settings menu, where you can configure:

1. **Editor** - Default editor for opening worktrees
   - Press `Enter` to select from available editors
   - Available: code, cursor, nvim, vim, subl, atom, zed
   - Default: VS Code (`code`)

2. **Base Branch** - Base branch for new worktree creation
   - Press `Enter` to select from available branches
   - Used when creating new branches with `n` key

3. **Theme** - Choose visual theme for the UI
   - 5 themes: Matrix, Coolify, Dracula, Nord, Solarized
   - Changes apply immediately without restart
   - Saved per repository

4. **AI Settings** - Configure AI features
   - OpenRouter API key management
   - Model selection (GPT-4, Claude, Gemini, etc.)
   - Enable/disable AI commit messages
   - Enable/disable AI branch naming
   - Test API key connectivity

5. **Tmux Config** - Install/update/remove opinionated tmux configuration
   - Press `Enter` to manage gcool's tmux config in `~/.tmux.conf`
   - Features: mouse support, 10k scrollback, 256 colors, Ctrl-D detach
   - Config is clearly marked and can be safely removed anytime

6. **Debug Logs** - Enable/disable debug logging
   - Logs written to `/tmp/gcool-debug.log`
   - Useful for troubleshooting and development

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

### Themes

**5 Built-in Themes**:

1. **Matrix** - Classic green terminal aesthetic
   - Primary: Green (#00FF00), Accent: Bright green (#00FF41)
   - Perfect for that hacker aesthetic

2. **Coolify** - Purple/violet theme
   - Primary: #9D4EDD, Accent: #E0AAFF
   - Modern and sleek

3. **Dracula** - Popular dark theme (pink/cyan)
   - Primary: #FF79C6, Accent: #8BE9FD
   - Eye-friendly with high contrast

4. **Nord** - Blue/cyan theme
   - Primary: #81A1C1, Accent: #88C0D0
   - Arctic-inspired color palette

5. **Solarized** - Blue/teal theme
   - Primary: #268BD2, Accent: #2AA198
   - Scientific color palette

**How to Change Theme**:
1. Press `s` to open settings
2. Navigate to "Theme" and press `Enter`
3. Use `↑`/`↓` to preview themes
4. Press `Enter` to apply
5. Theme changes instantly without restart
6. Your preference is saved automatically

### Base Branch

The base branch is used when creating new worktrees with new branches. gcool automatically determines the base branch:

1. Check saved config for repository
2. Fall back to current branch
3. Fall back to default branch (main/master)
4. Fall back to empty string (user must set manually)

You can change the base branch at any time by pressing `b` in the main view.

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
