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

### Backend-Owned Long-Running Jobs

Long-running operations that must survive web/mobile WebSocket disconnects
should be owned by Rust, not by a pending frontend `invoke()` response. The
frontend should start the job and receive an immediate job id; Rust
should run the process, persist the final state, and emit best-effort progress
events. After a disconnect-triggered reload, the frontend recovers from
persisted session/project data or job query commands instead of relying on the
original WebSocket response.

Current example: review magic uses `start_review_job`, which creates a Code
Review session with a running indicator and starts the AI/CodeRabbit review in a
Rust background task. AI review supports up to five distinct backend/model pairs
per worktree; each pair has its own model-compatible reasoning level. A batch of
AI reviews shares one Code Review session, and `review_results` stores the
backend/model results together so the review panel can switch between them;
entries are created with a running status so the dropdown can show loading
state before each result arrives.
Duplicate pairs are rejected while running. Job progress emits
`review-job:updated`.

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

- **Terminal** - Built-in PTY terminal emulator (`src-tauri/src/terminal/`).
  On Unix, terminals launched with a command run it through the user's
  interactive login shell so package scripts and native CLI sessions inherit
  the same PATH as a normally opened terminal. Structured command arguments
  are shell-escaped before launch; Windows continues to invoke binaries or
  `.cmd`/`.bat` shims directly to avoid PowerShell argument rewriting.
  Sessions can use chat or terminal as their primary surface via
  `useUIStore.sessionPrimarySurface`. Full-screen terminal sessions own exactly
  one terminal instance via `sessionTerminalIds` and must render through
  `SingleTerminalView`/`terminal-instances.ts` so the selected experimental
  terminal renderer is respected; terminal tab bars remain only for side/drawer
  terminals. Full-screen pure CLI sessions persist their intent on `Session`
  (`primary_surface`, `terminal_command`, `terminal_label`) and lazily recreate
  a PTY only when the user reopens that session, so hidden historical CLI
  sessions do not start background processes. Native Claude terminal sessions
  receive a generated `--session-id` when created. Codex and OpenCode terminal
  sessions snapshot their backend history before launch and bind the single new
  native session/thread ID back to Jean metadata; ambiguous concurrent matches
  are never guessed. Cold restoration uses `claude --resume <id>`,
  `codex resume <id>`, or `opencode --session <id>` while preserving global
  permission/yolo flags. Legacy native terminal sessions without either a typed
  ID or persisted resume arguments show the native-history picker instead of
  silently launching an unrelated conversation. The native CLI picker also merges
  backend-owned history from local stores where stable (`~/.codex/sessions/**`
  and `~/.claude/projects/<escaped-cwd>/**`) and imports a chosen history row as
  a Jean terminal session running the backend's native resume command. Resumable
  Jean chat sessions can likewise be duplicated into a separate native-client
  terminal session from the session-tab context menu; the original chat session
  remains unchanged.

  **Web-mode persistence.** In web access (Axum HTTP server + WebSocket),
  panel/side/drawer and modal terminals survive a full browser refresh. Three
  pieces cooperate:

  **Native remote UI.** When the desktop app selects a remote Jean, it keeps
  running its bundled React UI and routes shared backend commands and events to
  that server over authenticated HTTP/WebSocket transport. Local shell
  operations such as clipboard access, external URL opening, native menus, and
  notifications continue to use the local Tauri runtime.

  When an established WebSocket disconnects, the frontend reloads the page
  instead of repairing stale in-memory state. The normal
  HTTP bootstrap then restores current persisted state, while backend-owned
  jobs and terminals keep running. Before reload, the current canvas session
  modal and active session are copied to short-lived `sessionStorage` so the
  same session header is restored even if the debounced UI-state save has not
  completed yet.
  1. **Backend PTY registry** (`src-tauri/src/terminal/registry.rs`) keeps the
     real `portable_pty` process alive in `TERMINAL_SESSIONS` keyed by
     `terminal_id`. The frontend is a viewer; refresh never kills the PTY.

  2. **Event replay buffer** (`src-tauri/src/http_server/mod.rs`,
     `TERMINAL_BUFFER_MAX_EVENTS = 12000` events/terminal and
     `TERMINAL_BUFFER_MAX_BYTES = 3MB` per terminal) holds the most
     recent `terminal:output` and `terminal:started` envelopes with monotonic
     sequence numbers. After a full-page refresh, `requestTerminalReplay` asks
     for events after a given `last_seq` and the backend streams the buffered
     slice.

  3. **UI state hydration** (`src/hooks/useUIStatePersistence.ts`,
     `restoreTerminalRuntimeState`) is web-only. On load it reads
     `terminal_instances` / `terminal_active_ids` / `terminal_panel_open` /
     `terminal_visible` from `ui_state.json`, then asks the backend for
     `get_active_terminals`. Only persisted terminals whose IDs are still live
     survive the filter; dead-PTY entries are cleared along with their
     `sessionTerminalIds` mappings.

  The frontend module-level Map in `src/lib/terminal-instances.ts` is the
  xterm.js cache; it survives React mount/unmount but not page refresh. After a
  refresh, `attachToContainer` checks `has_active_terminal` and, if true, calls
  `requestTerminalReplay(terminalId, 0)` so the buffered output is painted back
  into a fresh xterm.

  **Ordering pitfall.** `TerminalView`'s auto-create-default-shell effect is
  gated by `useUIStore.uiStateInitialized`. That flag flips to `true` only
  after `useUIStatePersistence` finishes its async hydrate — otherwise the
  effect would race `restoreTerminalRuntimeState`, spawn a phantom shell that
  gets overwritten when restore completes, and leave an orphan PTY in
  `TERMINAL_SESSIONS`. Don't remove the `uiStateInitialized` guard without
  re-checking the race.

- **Background Tasks** - Git/PR polling with focus-aware intervals (`src-tauri/src/background_tasks/`); Auto Fix issue polling/planning/yolo handoff and scheduler active-hours window via `chrono` local time with midnight-crossing support (`src-tauri/src/auto_fix/`)
- **HTTP Server** - Tauri-free Axum server + WebSocket from `jean-core`; `src-server` provides the standalone Tokio adapter. See [server-architecture.md](./server-architecture.md).
- **Diagnostics** - CPU/memory monitoring panel (`src-tauri/src/diagnostics/`)
- **MCP** - Model Context Protocol server integration with per-project overrides (`src/services/mcp.ts`)
- **Model Catalog** - CDN-driven model lists and reasoning capabilities with bundled offline fallback ([model-catalog.md](./model-catalog.md))
- **CLI Management** - Claude CLI, Codex CLI, Cursor CLI, OpenCode, PI, Command Code, Grok, Kimi Code, and gh CLI installation/versioning (backend-specific modules under `src-tauri/src/`)

Cursor-specific notes:

- Cursor auth/status checks must use short timeouts; `cursor-agent status/about` can hang indefinitely
- Cursor chat integration should use `cursor-agent --print --output-format stream-json` and parse structured NDJSON, not terminal text scraping
- Cursor only supports `--mode plan` and `--mode ask`; build/yolo omit `--mode` (defaults to full agent) and use `--sandbox disabled --force`
- Cursor `plan` runs synthesize an `EnterPlanMode` timeline item from Jean so the native plan banner/instructions survive streaming + JSONL reload
- Cursor history repair should prefer complete message snapshots / repeated-prefix cleanup; avoid destructive suffix trimming during reload

Grok-specific notes:

- Grok chat uses ACP over stdio (`grok --no-auto-update agent --no-leader stdio`) instead of `grok -p`, because headless `-p` streaming JSON does not expose reliable tool-call events.
- Grok ACP processes are kept warm per Jean session and reused for follow-up prompts, then idle-stopped after five minutes. If the process is gone (app restart, crash, cancellation, model/mode flag change), Jean spawns a new ACP process and reloads via persisted `grok_session_id`.
- ACP `session/update` chunks are mapped to Jean's common chat stream events (`chat:chunk`, `chat:tool_use`, `chat:tool_result`, `chat:done`), and ACP session ids are persisted as `grok_session_id` for later `session/load`.
- Jean implements the minimal ACP client surface Grok needs for headless tool execution: `session/request_permission`, `terminal/*`, and text-file read/write requests. Plan mode auto-approves research tools (`read`/`search`/`think`/`fetch`/`execute`, including `run_terminal_command` / `terminal/*`) so investigations can use `gh`/`git`/`rg`/etc., and denies mutating file tools (`edit`/`delete`/`move`/`write`) plus hard-blocks `fs/write`; build/yolo auto-approve via ACP/CLI flags. Synthetic ExitPlanMode is only injected for plan-like content (not short research preambles).
- **All modes** launch Grok ACP with `--no-plan`. Grok's native `exit_plan_mode` requires the TUI approval surface ACP cannot show; leaving native plan enabled caused Jean plan-mode turns to hang after research. Jean plan mode is enforced with a plan-mode system instruction, mutation-blocking tool permissions, and synthetic ExitPlanMode. Build/yolo also pass `--always-approve`.
- Grok CLI currently advertises `promptCapabilities.image: false`. Jean rejects raster image attachments before saving or sending them, preserves already-pending images so the user can switch backends, and also validates Grok messages in Rust to prevent binary files from reaching ACP text-file reads. SVG attachments remain supported as text files.
- **MCP:** Jean discovers Grok-visible servers from `~/.grok/config.toml` / project `.grok/config.toml`, plus Claude/Cursor/`.mcp.json` compat sources (same merge set as grok-build). Health uses `grok mcp doctor --json`. On each turn Jean (1) temporarily syncs `disabled_mcp_servers` so only session-enabled servers auto-load, (2) passes enabled configs as ACP `mcpServers` on `session/new`/`session/load`, then (3) restores the previous disabled list when the turn ends. Unix detached hosts receive MCP via `--mcp-servers-file`.

Kimi Code-specific notes:

- Jean manages the official `@moonshot-ai/kimi-code` npm package or uses a `kimi` binary from `PATH`.
- Interactive chat uses the official `kimi acp` stdio protocol. Jean maps ACP text, thinking, tool, image, session-resume, cancellation, and permission-mode behavior into the shared chat event model.
- Jean maps execution modes to Kimi's native modes: `plan` → `plan`, `build` → `auto`, and `yolo` → `yolo`. Final plan text is exposed through Jean's standard plan-approval tool shape.
- Kimi session IDs are persisted as `kimi_session_id`; each follow-up starts a fresh ACP process and uses `session/resume` for conversation continuity. On Unix, interactive turns run through a detached Jean ACP host (`--jean-kimi-acp-host`) that owns Kimi's stdio, appends ACP updates to the run JSONL, accepts cancellation over a short local socket, and can be reattached through `resume_session` after Jean restarts. Windows retains the attached, non-survivable fallback.
- Configured models are discovered with `kimi provider list --json`. Magic-prompt operations use `kimi -p` with strict JSON instructions and validation because Kimi Code does not expose a native JSON Schema output flag.
- MCP entries are discovered from `~/.kimi-code/mcp.json` and project-local `.kimi-code/mcp.json`; Kimi Code loads those servers when the ACP session starts.

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
│   │   ├── Full-screen terminal surface (optional primary worktree surface)
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
│   ├── pi.rs              # PI RPC host/stream parsing/steering integration
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

Images pasted, dropped, or selected from the native file picker into chat are processed in Rust before saving:

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

### Cross-platform CLI resolution and launch

When resolving external CLIs from PATH, use `crate::platform::detect_cli_in_path()` or
`crate::platform::find_cli_in_host_path()` instead of parsing `where`/`which` output manually.
On Windows, npm installs can return an extensionless Unix shim before the runnable `.cmd`/`.exe`
shim; the shared selector ranks `.exe`, `.cmd`, `.bat`, extensionless, then `.ps1`.

When launching a resolved CLI path, use `crate::platform::cli_command()` instead of
`silent_command()` directly. It keeps `CREATE_NO_WINDOW`, wraps Windows `.cmd`/`.bat` shims with
`cmd.exe /C`, and routes commands through WSL when WSL mode is enabled. Pass the working directory
as the `cwd` argument so WSL launches receive `wsl.exe --cd ...` rather than a host-only cwd.
