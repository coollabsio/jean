# Architecture Guide

High-level architectural overview and mental models for the Jean desktop application (Tauri + React).

## Philosophy

1. **Clarity over Cleverness** - Predictable patterns over magic
2. **AI-Friendly Architecture** - Clear patterns that AI agents can follow
3. **Performance by Design** - Patterns that prevent common performance pitfalls
4. **Security First** - Built-in security patterns for file system operations
5. **Extensible Foundation** - Easy to add new features without refactoring

## Mental Models

### The "Onion" State Architecture

State management follows a clear three-layer hierarchy:

```
┌─────────────────────────────────────┐
│           useState                  │  ← Component UI State
│  ┌─────────────────────────────────┐│
│  │          Zustand                ││  ← Global UI State
│  │  ┌─────────────────────────────┐││
│  │  │      TanStack Query         │││  ← Persistent Data
│  │  └─────────────────────────────┘││
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

**Decision Tree:**

```
Is this data needed across multiple components?
├─ No → useState
└─ Yes → Does this data persist between app sessions?
    ├─ No → Zustand
    └─ Yes → TanStack Query
```

See [state-management.md](./state-management.md) for detailed patterns.

### Event-Driven Bridge Architecture

Rust and React communicate through three patterns:

```
1. User Actions:
   Menu Click / Keyboard Shortcut / Command Palette → Command Execution → State Update

2. Frontend → Backend:
   React → invoke("command_name", args) → Rust handler → Response

3. Backend → Frontend:
   Rust background task → app.emit("event-name", data) → React listen() handler → State Update
   (Used by git status polling, PR status updates, worktree events)
```

### Command-Centric Design

All user actions flow through a centralized command system:

- **Commands** are pure objects with `execute()` functions
- **Context** provides all state and actions commands need
- **Registration** merges commands from different domains at runtime

This decouples UI triggers from implementations and enables consistent behavior.

## System Architecture

### Core Systems

Each major system has focused documentation:

- **[Command System](./command-system.md)** - Unified action dispatch
- **[Keyboard Shortcuts](./keyboard-shortcuts.md)** - Native event handling
- **[Native Menus](./menus.md)** - Cross-platform menu integration
- **[Data Persistence](./data-persistence.md)** - Disk storage patterns
- **[State Management](./state-management.md)** - Zustand + TanStack Query patterns
- **[Notifications](./notifications.md)** - Toast and native notifications
- **[Logging](./logging.md)** - Rust and TypeScript logging
- **[Performance](./performance-patterns.md)** - Render optimization patterns
- **[Testing](./testing.md)** - Quality gates and test patterns
- **[Releases](./releases.md)** - Automated release process
- **[Auto-Updates](./auto-updates.md)** - Update system integration
- **[Bundle Optimization](./bundle-optimization.md)** - Build size optimization

Additional systems (no dedicated docs yet):

- **Terminal** - Built-in PTY terminal emulator (`src-tauri/src/terminal/`)
- **Background Tasks** - Git/PR polling with focus-aware intervals (`src-tauri/src/background_tasks/`)
- **HTTP Server** - Embedded Axum server + WebSocket for headless/web mode (`src-tauri/src/http_server/`)
- **Diagnostics** - CPU/memory monitoring panel (`src-tauri/src/diagnostics/`)
- **MCP** - Model Context Protocol server integration with per-project overrides (`src/services/mcp.ts`)
- **CLI Management** - Claude CLI, Codex CLI, OpenCode, and gh CLI installation/versioning (`src-tauri/src/claude_cli/`, `src-tauri/src/codex_cli/`, `src-tauri/src/opencode/`, `src-tauri/src/gh_cli/`)

### Component Hierarchy

```
MainWindow (Top-level orchestrator)
├── DevModeBanner (dev-only overlay)
├── TitleBar (Window controls + toolbar)
├── LeftSideBar (Collapsible, pixel-resizable)
│   └── ProjectsSidebar
│       └── ProjectTree → WorktreeList per project
├── MainWindowContent (Primary content area)
│   ├── ChatWindow (when worktree selected — always shows chat view)
│   │   ├── Chat view (VirtualizedMessageList + ChatInput + ChatToolbar)
│   │   ├── TerminalPanel (integrated PTY terminal)
│   │   └── ReviewResultsPanel (AI code review findings)
│   ├── ProjectCanvasView (when project selected, no active worktree)
│   └── Welcome screen (when nothing selected)
└── Global Overlays
    ├── CommandPalette
    ├── PreferencesDialog
    ├── ProjectSettingsDialog
    ├── CommitModal
    ├── OnboardingDialog / FeatureTourDialog / JeanConfigWizard
    ├── CliUpdateModal / UpdateAvailableModal / CliLoginModal
    ├── OpenInModal
    ├── WorkflowRunsModal
    ├── MagicModal / ReleaseNotesDialog / UpdatePrDialog
    ├── NewWorktreeModal / BranchConflictDialog
    ├── AddProjectDialog / GitInitModal
    ├── ArchivedModal / CloseWorktreeDialog / QuitConfirmationDialog
    └── Toaster (Notifications)
```

### Canvas View

**ProjectCanvasView** (`src/components/dashboard/ProjectCanvasView.tsx`) shows sessions across all worktrees in a project, grouped by worktree with section headers. Sessions are opened via `SessionChatModal` overlay.

Shared infrastructure in `src/components/chat/`:

- `SessionListRow.tsx` - Compact row component for list view
- `session-card-utils.tsx` - `computeSessionCardData()` and `SessionCardData` type
- `hooks/useCanvasKeyboardNav.ts` - Arrow key navigation with visual-position neighbor finding
- `hooks/useCanvasShortcutEvents.ts` - Event handlers for plan/recap/approve shortcuts
- `hooks/useCanvasStoreState.ts` - Store state subscriptions for card data

### File Organization

```
src/
├── components/
│   ├── actions/           # ActionsSidebar
│   ├── archive/           # ArchivedModal
│   ├── chat/              # ChatWindow + 50 files, 12 extracted hooks in chat/hooks/
│   ├── command-palette/   # CommandPalette (cmdk-based)
│   ├── commit/            # CommitModal
│   ├── dashboard/         # ProjectCanvasView
│   ├── layout/            # MainWindow, MainWindowContent, sidebars, update modals
│   ├── magic/             # MagicModal, LoadContextModal, ReleaseNotesDialog, UpdatePrDialog
│   ├── onboarding/        # OnboardingDialog, FeatureTourDialog, JeanConfigWizard
│   ├── open-in/           # OpenInButton, OpenInModal
│   ├── preferences/       # PreferencesDialog, DiagnosticsPanel, 8 settings panes
│   ├── projects/          # ProjectTree, WorktreeList, AddProjectDialog, ProjectSettingsDialog
│   ├── shared/            # FailedRunsBadge, GhAuthError, OpenPRsBadge, WorkflowRunsModal
│   ├── titlebar/          # TitleBar, platform-specific window controls
│   ├── ui/                # 45+ shadcn/ui primitives
│   └── worktree/          # NewWorktreeModal, BranchConflictDialog
├── hooks/                 # 20+ global hooks
│   ├── useUIStatePersistence.ts      # Persist UI state to disk
│   ├── useSessionStatePersistence.ts # Persist session state to disk
│   ├── useMainWindowEventListeners.ts # Global keyboard/event handlers
│   ├── useArchiveCleanup.ts          # Auto-cleanup old archived items
│   ├── useAutoArchiveOnMerge.ts      # Archive worktrees when PRs merge
│   ├── usePrWorktreeSweep.ts         # Sync PR worktrees for polling
│   ├── useCliVersionCheck.ts         # CLI version monitoring
│   ├── useTerminal.ts                # PTY terminal lifecycle
│   └── ...                           # useGhLogin, useSessionPrefetch, etc.
├── lib/
│   ├── commands/          # Command system (registry + 6 domain command files)
│   ├── query-client.ts    # TanStack Query client configuration
│   ├── logger.ts          # Frontend logging
│   ├── sounds.ts          # Audio feedback
│   └── ...                # utils, platform detection, theme, recovery
├── services/              # TanStack Query hooks + Tauri invoke wrappers
│   ├── chat.ts            # Session/message queries and mutations
│   ├── claude-cli.ts      # Claude CLI queries
│   ├── projects.ts        # Project/worktree queries
│   ├── github.ts          # GitHub issue/PR queries
│   ├── git-status.ts      # Git status polling + events
│   ├── mcp.ts             # MCP server configuration
│   ├── preferences.ts     # App preferences queries
│   ├── ui-state.ts        # UI state persistence queries
│   └── ...                # files, gh-cli, pr-status, skills
├── store/                 # Zustand stores
│   ├── chat-store.ts      # Active sessions, streaming state, canvas tabs
│   ├── projects-store.ts  # Selected project/worktree, sidebar state
│   ├── terminal-store.ts  # Terminal instances and state
│   └── ui-store.ts        # Sidebar visibility, modal state, preferences cache
└── types/                 # Shared TypeScript types
    ├── chat.ts, preferences.ts, projects.ts, ui-state.ts
    ├── github.ts, gh-cli.ts, claude-cli.ts, pr-status.ts
    └── diagnostics.ts, keybindings.ts, terminal.ts, commands.ts
```

## Rust Backend Modules

```
src-tauri/src/
├── lib.rs                 # App setup, AppState, AppPreferences, UIState structs, command registration
├── main.rs                # Entry point
├── chat/                  # Session lifecycle management
│   ├── commands.rs        # Tauri commands (send message, create session, image processing)
│   ├── claude.rs          # Claude CLI process spawning and management
│   ├── detached.rs        # Detached process recovery (survives app quit via nohup)
│   ├── registry.rs        # Active session registry
│   ├── storage.rs         # Session data on disk
│   ├── tail.rs            # JSONL output file tailing for real-time streaming
│   ├── naming.rs          # AI-powered session naming
│   ├── run_log.rs         # Run history logging
│   └── types.rs           # Chat domain types
├── projects/              # Project and worktree management
│   ├── commands.rs        # Tauri commands (CRUD, git ops, PR creation)
│   ├── git.rs             # Git operations (commit, branch, worktree management)
│   ├── git_status.rs      # Git status parsing
│   ├── github_issues.rs   # GitHub Issues API
│   ├── github_actions.rs  # GitHub Actions API
│   ├── pr_status.rs       # PR status tracking
│   ├── saved_contexts.rs  # Context saving with AI summarization
│   ├── storage.rs         # Project data on disk
│   └── types.rs           # Project domain types
├── background_tasks/      # Background polling manager
│   └── commands.rs        # Focus-aware git/PR polling with tiered intervals
├── http_server/           # Embedded web server for headless mode
│   ├── server.rs          # Axum HTTP server setup
│   ├── websocket.rs       # WebSocket for real-time events
│   ├── dispatch.rs        # Request routing to Tauri commands
│   └── auth.rs            # Bearer token authentication
├── terminal/              # Built-in terminal emulator
│   ├── commands.rs        # Tauri commands (create, write, resize)
│   ├── pty.rs             # Platform PTY implementation
│   ├── registry.rs        # Terminal instance registry
│   └── types.rs           # Terminal types
├── diagnostics/           # System monitoring
│   └── commands.rs        # CPU/memory sampling via sysinfo crate
├── claude_cli/            # Claude CLI binary management
│   ├── commands.rs        # Install, version check, path resolution
│   └── config.rs          # CLI configuration
├── gh_cli/                # GitHub CLI binary management
│   ├── commands.rs        # Install, version check, auth status
│   └── config.rs          # GH CLI configuration
└── platform/              # Platform abstractions
    ├── process.rs         # silent_command() - prevents Windows console flash
    └── shell.rs           # Default shell detection
```

## Performance Patterns

### The `getState()` Pattern (Critical)

**Problem**: Store subscriptions in callbacks cause render cascades.

**Solution**: Use `getState()` for callbacks that need current state:

```typescript
// ✅ Good: Stable callback, no cascades
const handleAction = useCallback(() => {
  const { currentData, updateData } = useStore.getState()
  updateData(currentData.modified)
}, []) // Empty deps - stable reference

// ❌ Bad: Re-creates on every state change
const { currentData, updateData } = useStore()
const handleAction = useCallback(() => {
  updateData(currentData.modified)
}, [currentData, updateData]) // Cascades on every change
```

See [performance-patterns.md](./performance-patterns.md) for complete patterns.

## Security Architecture

### Rust-First Security

All file operations happen in Rust with built-in validation:

```rust
// Path validation prevents traversal attacks
fn is_blocked_directory(path: &Path) -> bool {
    let blocked_patterns = ["/System/", "/usr/", "/etc/", "/.ssh/"];
    blocked_patterns.iter().any(|pattern| path.starts_with(pattern))
}
```

### Input Sanitization

```rust
// Filename sanitization
pub fn sanitize_filename(filename: &str) -> String {
    filename.chars()
        .filter(|c| !['/', '\\', ':', '*', '?', '"', '<', '>', '|'].contains(c))
        .collect()
}
```

## Integration Patterns

### Multi-Source Event Coordination

The same action can be triggered from multiple sources:

```typescript
// All trigger the same command
handleKeyboard('cmd+comma') → commandContext.openPreferences()
handleMenu('menu-preferences') → commandContext.openPreferences()
handleCommand('open-preferences') → commandContext.openPreferences()
```

### Atomic File Operations

All disk writes use atomic operations to prevent corruption:

```rust
// Write to temp file, then rename (atomic)
std::fs::write(&temp_path, content)?;
std::fs::rename(&temp_path, &final_path)?;
```

### Image Processing

Images pasted or dropped into chat are processed in Rust before saving:

- **Resize**: Max 1568px on longest side (Claude's internal limit)
- **Compress**: Opaque PNGs → JPEG at 85% quality (typically 5-10x smaller)
- **Skip**: GIFs (may be animated), images < 50KB, already-compressed formats
- Token cost: `(width × height) / 750` tokens per image

### Headless Mode

The embedded Axum HTTP server enables running Jean without the native window:

- Serves the bundled frontend via `ServeDir`
- WebSocket provides real-time event streaming (mirrors Tauri's `emit`/`listen` pattern)
- Bearer token authentication; configurable port; localhost-only by default

## Development Workflow

### Quality Gates

Before any changes are committed:

```bash
bun run check:all  # Runs all checks
```

This includes:

- TypeScript type checking
- ESLint linting
- Prettier formatting
- Vitest tests
- Rust formatting (cargo fmt)
- Rust linting (clippy)
- Rust tests

### Documentation-Driven Development

1. **Understand patterns** - Read relevant docs in `docs/developer/`
2. **Follow established patterns** - Don't invent new approaches
3. **Update docs** - Document new patterns as they emerge
4. **Test comprehensively** - Use the established testing patterns

## Extension Points

### Adding New Features

1. **Commands** - Add to appropriate command group file
2. **State** - Choose appropriate layer (useState/Zustand/TanStack Query)
3. **UI** - Follow component architecture guidelines
4. **Persistence** - Use established data persistence patterns
5. **Testing** - Add tests following established patterns
6. **Documentation** - Update relevant docs

### Adding New Systems

When adding entirely new systems:

1. **Create focused docs** - Add new file to `docs/developer/`
2. **Follow architectural patterns** - Use established bridge patterns
3. **Integrate with command system** - Make actions discoverable
4. **Add keyboard shortcuts** - Follow shortcut conventions
5. **Update this guide** - Add system to architecture overview

## Best Practices Summary

1. **Follow the onion** - Use the three-layer state architecture
2. **Commands everywhere** - Route all actions through the command system
3. **Performance first** - Use `getState()` pattern to avoid cascades
4. **Security by default** - Validate all inputs, especially file paths
5. **Event-driven bridges** - Keep Rust and React loosely coupled
6. **Test everything** - Use quality gates to maintain code health
7. **Document patterns** - Keep docs current as patterns evolve
