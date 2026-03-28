# Claude Instructions

## Current Status

@CLAUDE.local.md

## Overview

This repository is a template with sensible defaults for building Tauri React apps.

## Core Rules

### New Sessions

- Read @docs/tasks.md for task management
- Review `docs/developer/architecture-guide.md` for high-level patterns
- Check `docs/developer/` for system-specific patterns (command-system.md, performance-patterns.md, etc.)
- Check git status and project structure

### Development Practices

**CRITICAL:** Follow these strictly:

1. **Read Before Editing**: Always read files first to understand context
2. **Follow Established Patterns**: Use patterns from this file and `docs/developer`
3. **Senior Architect Mindset**: Consider performance, maintainability, testability
4. **Batch Operations**: Use multiple tool calls in single responses
5. **Match Code Style**: Follow existing formatting and patterns
6. **Test Coverage**: Write comprehensive tests for business logic
7. **Quality Gates**: Run `bun run check:all` after significant changes
8. **No Dev Server**: Ask user to run and report back
9. **No Unsolicited Commits**: Only when explicitly requested
10. **Documentation**: Update relevant `docs/developer/` files for new patterns
11. **Removing files**: Always use `rm -f`

**CRITICAL:** Use Tauri v2 docs only. Always use modern Rust formatting: `format!("{variable}")`

## Architecture Patterns (CRITICAL)

### State Management Onion

```
useState (component) → Zustand (global UI) → TanStack Query (persistent data)
```

**Decision**: Is data needed across components? → Does it persist between sessions?

### Performance Pattern (CRITICAL)

```typescript
// ✅ GOOD: Use getState() to avoid render cascades
const handleAction = useCallback(() => {
  const { data, setData } = useStore.getState()
  setData(newData)
}, []) // Empty deps = stable

// ❌ BAD: Store subscriptions cause cascades
const { data, setData } = useStore()
const handleAction = useCallback(() => {
  setData(newData)
}, [data, setData]) // Re-creates constantly
```

### Event-Driven Bridge

- **Rust → React**: `app.emit("event-name", data)` → `listen("event-name", handler)`
- **React → Rust**: `invoke("command_name", args)` with TanStack Query
- **Commands**: All actions flow through centralized command system

### Documentation & Versions

- **Context7 First**: Always use Context7 for framework docs before WebSearch
- **Version Requirements**: Tauri v2.x, shadcn/ui v4.x, Tailwind v4.x, React 19.x, Zustand v5.x, Vite v7.x, Vitest v4.x

### Important Findings & Learnings

**Document discoveries here.** When encountering major/minor findings during development, ask the user if they should be saved to this file for future reference.

#### Rust-TypeScript Serialization Convention

**CRITICAL:** There are two patterns for Rust-TypeScript serialization. Pick ONE per struct and be consistent.

**Pattern A: snake_case (for persisted/settings data)**

- Used for: `AppPreferences`, `UIState`, and other persisted data
- Rust structs use snake_case by default (e.g., `active_worktree_id`)
- TypeScript interfaces must match exactly (e.g., `active_worktree_id`, NOT `activeWorktreeId`)
- See `src/types/preferences.ts` and `src/types/ui-state.ts` for examples

**Pattern B: camelCase with `#[serde(rename_all = "camelCase")]` (for API/command data)**

- Used for: Data passed between frontend and Tauri commands (e.g., `IssueContext`, `PullRequestContext`)
- Add `#[serde(rename_all = "camelCase")]` to Rust struct
- TypeScript uses standard camelCase (e.g., `headRefName`, `baseRefName`)
- See `src-tauri/src/projects/github_issues.rs` for examples

**Common error:** `invalid args for command: missing field 'field_name'`

- This means Rust expects snake_case but frontend sent camelCase (or vice versa)
- Fix: Add `#[serde(rename_all = "camelCase")]` to the Rust struct, OR change TypeScript to snake_case

#### UI State Persistence Pattern

Session-specific UI state (e.g., answered questions, fixed review findings) must be persisted via the existing Tauri backend system, not Zustand middleware:

1. **Add fields to** `src/types/ui-state.ts` (TypeScript interface, use `snake_case`)
2. **Add fields to** `src-tauri/src/lib.rs` (Rust `UIState` struct with `#[serde(default)]`)
3. **Update** `src/hooks/useUIStatePersistence.ts`:
   - Extract state in `getCurrentUIState()` (map camelCase store → snake_case UIState, convert Sets to arrays)
   - Restore state in initialization effect (map snake_case UIState → camelCase store, convert arrays back to Sets)
   - Track changes in subscription effect to trigger saves

**Key insight**: The `hasFollowUpMessage` check in `ChatWindow.tsx` (checks if a user message follows an assistant message) is meant as a fallback but may have timing issues with TanStack Query. Persisting state directly provides reliable rendering.

#### Zustand Getter Function Anti-Pattern

**CRITICAL:** Never subscribe to a getter function and call it directly in JSX. This creates NO subscription to the underlying data.

```typescript
// BAD: Subscribes to function reference (stable), NOT to viewingLogsTab data
const isViewingLogs = useChatStore(state => state.isViewingLogs)
return isViewingLogs(worktreeId) ? <LogsView /> : <ChatView />
// viewingLogsTab changes will NOT trigger re-render!

// GOOD: Subscribes to actual data - triggers re-render when data changes
const isViewingLogsTab = useChatStore(state =>
  state.activeWorktreeId ? state.viewingLogsTab[state.activeWorktreeId] ?? false : false
)
return isViewingLogsTab ? <LogsView /> : <ChatView />
```

**When getter functions ARE okay:**

- Passing to memoized children as props (children handle their own rendering)
- Using inside `useMemo` with proper data dependencies
- Using inside callbacks obtained via `getState()`

**The bug:** Zustand selectors subscribe to whatever the selector returns. If you return a function, you subscribe to that function reference (which never changes), not the data the function reads internally.

#### Zustand Store Mutation Guards

**CRITICAL:** Every Zustand `set()` call notifies ALL subscribers, even if the value didn't change. `useShallow` only prevents re-renders if the selected field references are identical. Store mutations that spread new objects (`{...state.field, [id]: value}`) without checking whether the value actually changed will cause unnecessary re-renders across every component subscribing to that store.

```typescript
// ✅ GOOD: Guard against no-op updates
addSendingSession: sessionId =>
  set(state => {
    if (state.sendingSessionIds[sessionId]) return state // No new ref
    return {
      sendingSessionIds: { ...state.sendingSessionIds, [sessionId]: true },
    }
  })

// ❌ BAD: Always creates new object reference, triggers all subscribers
addSendingSession: sessionId =>
  set(state => ({
    sendingSessionIds: { ...state.sendingSessionIds, [sessionId]: true },
  }))
```

**Guard patterns by type:**

- **Boolean Records:** `if (state.field[id]) return state` / `if (!(id in state.field)) return state`
- **Value Records:** `if (state.field[id] === value) return state`
- **Array fields:** `if (!existing || existing.output === output) return state`
- **Set fields:** `if (existingSet.has(value)) return state`

#### Debugging Re-renders with WDYR

To diagnose unnecessary re-renders, temporarily install [why-did-you-render](https://github.com/welldone-software/why-did-you-render):

1. `bun add -d @welldone-software/why-did-you-render`
2. Create `src/wdyr.ts`:
   ```typescript
   if (import.meta.env.DEV) {
     const whyDidYouRender = (
       await import('@welldone-software/why-did-you-render')
     ).default
     whyDidYouRender(React, { trackAllPureComponents: false })
   }
   ```
3. Import at top of `src/main.tsx`: `import './wdyr'`
4. Annotate suspect components: `MyComponent.whyDidYouRender = true`
5. Check browser console for "Re-rendered because of hook changes" / "different objects that are equal by value"
6. **Before releasing:** Remove all annotations, `wdyr.ts`, its import, and `bun remove @welldone-software/why-did-you-render`

#### Claude CLI JSON Schema Pattern

**CRITICAL:** When using `--json-schema` with Claude CLI, structured output is returned via a tool call, not plain text.

- Claude uses a synthetic `StructuredOutput` tool to return JSON schema responses
- The data is in `message.content[].input` where `content[].name == "StructuredOutput"`
- Regular text blocks may still appear before the tool call (e.g., "I'll create...")
- The `result` field does NOT contain the structured data

**Stream-JSON output structure:**

```json
{
  "type": "assistant",
  "message": {
    "content": [
      { "type": "text", "text": "I'll create a structured summary..." },
      {
        "type": "tool_use",
        "id": "toolu_xxx",
        "name": "StructuredOutput",
        "input": { "slug": "my-slug", "summary": "..." }
      }
    ]
  }
}
```

**Extraction pattern** (see `src-tauri/src/chat/commands.rs:extract_text_from_stream_json`):

```rust
for block in content {
    if block.get("type") == Some("tool_use")
       && block.get("name") == Some("StructuredOutput") {
        return block.get("input").clone(); // This is your JSON schema data
    }
}
```

**Usage in this codebase:**

- Context summarization: `execute_summarization_claude()` uses `--json-schema` to get `{summary, slug}`
  - Schema constant: `CONTEXT_SUMMARY_SCHEMA` in `src-tauri/src/chat/commands.rs`
- PR content generation: `generate_pr_content()` uses `--json-schema` to get `{title, body}`
  - Schema constant: `PR_CONTENT_SCHEMA` in `src-tauri/src/projects/commands.rs`
  - Tauri command: `create_pr_with_ai_content` - creates PR with AI-generated title/body

#### Background Operations with Toast Notifications

**Pattern:** For operations that run in the background (not in chat), use toast notifications instead of inline UI state indicators.

```typescript
// ✅ GOOD: Toast-based feedback for background operations
const handleBackgroundOperation = useCallback(async () => {
  const toastId = toast.loading('Operation in progress...')

  try {
    const result = await invoke<ResultType>('backend_command', { args })

    // Invalidate relevant queries to refresh UI
    queryClient.invalidateQueries({ queryKey: ['relevant-query'] })

    toast.success(`Success: ${result.message}`, { id: toastId })
  } catch (error) {
    toast.error(`Failed: ${error}`, { id: toastId })
  }
}, [queryClient])

// ❌ BAD: Zustand state for loading indicators
const [isLoading, setIsLoading] = useState(false)
// ... requires passing state through props, tracking lifecycle, etc.
```

**Key points:**

- Use `toast.loading()` at start, update with `toast.success/error()` using same `id`
- For opening URLs in Tauri, use `openUrl` from `@tauri-apps/plugin-opener` (not `window.open`)
- Close modals immediately after dispatching action (don't wait for completion)
- Invalidate TanStack Query caches after mutations to refresh UI

**Current background operations using this pattern:**

- `handleSaveContext` in `ChatWindow.tsx` - saves context with AI summarization
- `handleOpenPr` in `ChatWindow.tsx` - creates PR with AI-generated title/body
- `handleCommit` in `ChatWindow.tsx` - creates commit with AI-generated message (uses `create_commit_with_ai` command with JSON schema)
- `handleReview` in `ChatWindow.tsx` - runs AI code review, stores results in Zustand/UI state, shows in ReviewResultsPanel (uses `run_review_with_ai` command with JSON schema)

**Toast action buttons:**

```typescript
toast.success('PR created', {
  id: toastId,
  action: {
    label: 'Open',
    onClick: () => openUrl(result.url), // Use Tauri plugin, not window.open
  },
})
```

#### Windows Console Window Flash Prevention

**CRITICAL:** On Windows, every `std::process::Command::new()` call opens a visible console window that briefly flashes on screen unless `CREATE_NO_WINDOW` (0x08000000) is set via `creation_flags()`.

**Use `silent_command()` for all background operations:**

```rust
use crate::platform::silent_command;

// ✅ GOOD: No console window flash
let output = silent_command("git")
    .args(["status", "--porcelain"])
    .current_dir(repo_path)
    .output()?;

// ❌ BAD: Flashes a console window on Windows
let output = Command::new("git")
    .args(["status", "--porcelain"])
    .current_dir(repo_path)
    .output()?;
```

**Keep `Command::new()` ONLY for commands that intentionally open UI:**

- File managers: `open`, `explorer`, `xdg-open`
- Terminals: `wt`, `powershell`, `cmd`, terminal emulators
- Editors: `code`, `cursor`, `xed`
- macOS automation: `osascript`

**For detached processes** that need both `CREATE_NO_WINDOW` and `CREATE_NEW_PROCESS_GROUP`: use `silent_command()` but re-set both flags via `creation_flags()` (it replaces, doesn't merge).

The helper is defined in `src-tauri/src/platform/process.rs` and exported via `pub use process::*` in `platform/mod.rs`.

#### Canvas Views Architecture

**"Canvas"** refers to **ProjectCanvasView** (`src/components/dashboard/ProjectCanvasView.tsx`):

- Project-level canvas showing worktrees as compact list rows (with section headers)
- Sessions are opened via `SessionChatModal` overlay
- Navigation: clicking "back" from ChatWindow returns to ProjectCanvasView via `clearActiveWorktree()`
- Clicking a worktree in the sidebar stays on ProjectCanvasView (does not open ChatWindow)

**Shared Hooks** (in `src/components/chat/hooks/`):

- `useCanvasKeyboardNav.ts` - Arrow key navigation (up/down), Enter selection
- `useCanvasShortcutEvents.ts` - Event handlers for `open-plan`, `open-recap`, `approve-plan`, etc.
- `useCanvasStoreState.ts` - Subscribes to chat store state needed for `SessionCardData`

**Shared Components**:

- `SessionListRow.tsx` - Compact row component for list view
- `session-card-utils.tsx` - `computeSessionCardData()`, `SessionCardData`, and `SessionCardProps` types

#### Image Processing on Paste/Drop

Images pasted or dropped into chat are processed before saving (`process_image()` in `src-tauri/src/chat/commands.rs`):

- **Resize**: Max 1568px on longest side (Claude's internal limit — anything larger gets downscaled by Claude anyway, wasting bandwidth). Images below 200px on any edge may degrade Claude's vision performance.
- **Compress**: Opaque PNGs → JPEG at 85% quality (typically 5-10x smaller). PNGs with transparency stay PNG.
- **Skip**: GIFs (may be animated), images < 50KB, already-compressed formats (JPEG/WebP below 1568px).
- **Performance**: Uses `Triangle` (bilinear) filter for resize, runs in `spawn_blocking` to avoid blocking async runtime.
- **Token cost**: `(width × height) / 750` tokens per image. Max optimal size (~1568×1568) ≈ 3,280 tokens.
- **Reference**: https://platform.claude.com/docs/en/build-with-claude/vision

#### Adding a New Claude Model

Three files need updating when adding a new model option:

1. **`src/types/preferences.ts`** — Add to `ClaudeModel` type union and `modelOptions` array (full labels like "Claude Sonnet 4.6"). Model IDs use short names: `opus`, `sonnet`, `haiku`
2. **`src/store/chat-store.ts`** — Add to duplicated `ClaudeModel` type union (line ~27)
3. **`src/components/chat/ChatToolbar.tsx`** — Add to `MODEL_OPTIONS` array (short labels like "Sonnet 4.6")

No Rust changes needed — model is stored as `String` in `AppPreferences` and passed directly to `--model` CLI flag.

#### Per-Project Worktrees Location

Projects have an optional `worktrees_dir: Option<String>` field that overrides the default `~/jean` base directory for worktree creation.

- **Rust**: `Project.worktrees_dir` in `src-tauri/src/projects/types.rs`
- **TypeScript**: `Project.worktrees_dir` in `src/types/projects.ts`
- **Path resolution**: `get_project_worktrees_dir(name, custom_base_dir)` in `src-tauri/src/projects/storage.rs`
  - When `Some(dir)` → `<dir>/<project-name>/<worktree-name>`
  - When `None` → `~/jean/<project-name>/<worktree-name>`
  - The `<project-name>` subdirectory is always appended to prevent collisions when multiple projects share the same custom base dir
- **UI**: "Worktrees Location" section in `src/components/projects/panes/GeneralPane.tsx` (Browse + Save + Reset)
- **Saved via**: `update_project_settings` Tauri command, `worktrees_dir: Option<Option<String>>` param (outer Option = not updating, inner Option = clear/set)

#### Adding New Tauri Commands (Web Access Dispatch)

**CRITICAL:** Every new `#[tauri::command]` must ALSO be registered in the WebSocket dispatch handler, or it will only work in the native app and fail with `"Unknown command"` in web access.

**Two places to register every command:**

1. **`src-tauri/src/lib.rs`** — `tauri::generate_handler![...]` (native Tauri IPC)
2. **`src-tauri/src/http_server/dispatch.rs`** — `dispatch_command()` match arms (WebSocket transport)

**Dispatch pattern:**

```rust
// In dispatch.rs — match arm inside dispatch_command()
"my_new_command" => {
    // Use field() for camelCase/snake_case dual-key extraction
    let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
    // Use from_field() for single-key extraction
    let name: String = from_field(&args, "name")?;
    // Use from_field_opt() / field_opt() for Option<T>
    let model: Option<String> = from_field_opt(&args, "model")?;

    let result = crate::my_module::my_new_command(app.clone(), worktree_id, name, model).await?;
    to_value(result) // or Ok(Value::Null) for () return
}
```

**Helper functions in dispatch.rs:**

- `to_value(result)` — Serialize return value to `serde_json::Value`
- `from_field(&args, "key")` — Extract required field (single key)
- `from_field_opt(&args, "key")` — Extract optional field (single key)
- `field(&args, "camelKey", "snake_key")` — Extract required field (tries camelCase first, then snake_case)
- `field_opt(&args, "camelKey", "snake_key")` — Extract optional field (dual-key)
- `emit_cache_invalidation(app, &["sessions", "session"])` — Broadcast cache invalidation to all clients

**Module path rules** (use re-exports, NOT private `::commands::` paths):

- `crate::chat::` — chat commands (re-exported via `pub use commands::*`)
- `crate::codex_cli::` — codex CLI commands (re-exported via `pub use commands::*`)
- `crate::projects::` — project/git/github/linear commands (re-exported via `pub use commands::*`, `pub use github_issues::*`, etc.)
- `crate::background_tasks::commands::` — background task commands (public module, direct access)
- `crate::` — top-level commands defined in `lib.rs` (e.g., `save_cli_profile`)

**For `State<'_, T>` params** (e.g., `BackgroundTaskManager`): extract via `app.state::<T>()`:

```rust
let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
crate::background_tasks::commands::my_command(state, arg)?;
```

**Checklist for new commands:**

- [ ] Add `#[tauri::command]` function
- [ ] Register in `lib.rs` `generate_handler![]`
- [ ] Add match arm in `dispatch.rs` `dispatch_command()`
- [ ] Add `emit_cache_invalidation()` if the command mutates data that other clients should refresh
