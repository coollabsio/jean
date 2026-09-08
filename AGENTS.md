# AI Agents

## Current Status

@CLAUDE.local.md

## Overview

This repository is a template with sensible defaults for building Tauri React apps.

## Core Rules

### Codex App Server schema

If you need to check some codex app-server related things, use "codex app-server generate-json-schema --out ./codex-schema" to generate schema and check local dir ./codex-schema for schemas.

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
8. **Dev Server**: You may start the dev server (`bun run tauri dev`) when needed
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

#### PI CLI JSON Output Format

**Read this before changing PI chat parsing** (`src-tauri/src/chat/pi.rs`).

Interactive Jean chat runs PI through Jean's detached PI RPC host on Unix/macOS:
Jean launches itself with `--jean-pi-rpc-host`; that host owns a `pi --mode rpc`
child, keeps stdin open after Jean quits, writes PI stdout JSONL into Jean's
run log, and accepts local socket commands for `prompt`, `steer`, and `abort`.
The socket lives under Jean's app-data directory with a short filename to stay
within macOS Unix socket path limits. This is required because PI RPC exits when
stdin closes. Windows/non-detached fallbacks may still use direct child
execution and are non-survivable.

Jean persists its own session/run JSONL (run logs) — PI's event/session format
is only used to parse PI output before writing Jean history. References:
https://pi.dev/docs/latest/rpc and https://pi.dev/docs/latest/session-format

- **Streaming assistant text** arrives as `message_update` / `assistant` events.
  Deltas are read from `assistantMessageEvent.delta` (type `text_delta`), or a
  top-level `delta`/`text` field. Thinking deltas use `delta.type == "thinking_delta"`.
- **Final assistant content** (text, thinking, tool calls), tool results, and
  usage are nested under `type: "message"` lifecycle entries — `message.role` is
  `assistant` (content blocks: `text`, `thinking`, `toolCall`) or `toolResult`.
- **Tool lifecycle** also emitted as discrete `tool_execution_start` / `tool_call`
  and `tool_execution_end` / `tool_result` events.
- **Session id** comes from `session_id` / `sessionId`, or a `type: "session"`
  entry's `id`. This becomes Jean's `pi_session_id` resume id.
- **Usage** is read from `usage` / `token_usage` on `message`, `message_end`,
  `turn_end`, `agent_end`, or `result` events.
- **Steering** uses the RPC `steer` command through `steer_pi_turn`. Only plain
  queued prompts (no files/images/skills/text attachments) are steerable.
- **Background recovery** mirrors Codex's survivable app-server pattern:
  host-backed PI runs store the host PID on the run, are treated as detached
  survivable sessions, and `resume_session` tails the run JSONL with the PI
  parser after Jean restarts. The host appends a synthetic `type: "result"`
  marker after `agent_end` so completed-while-closed runs recover as completed.

**Parsing is incremental:** `merge_pi_line()` merges one parsed line into the
accumulating `PiResponse`. Both the batch parser (`parse_pi_json_stream_inner`)
and the live streaming parser (`parse_pi_stream`) call it per line — never
re-parse the whole accumulated buffer (avoids O(n²) on long sessions).

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

**For opening URLs in the browser:** use `open_url_in_browser()` (not raw `cmd /c start`). On Windows the shell-association path still uses `cmd /c start`, but only through `silent_command()` so the intermediary console never flashes (issue #588).

The helpers are defined in `jean-core/src/platform/process.rs` and re-exported via `pub use process::*` in `platform/mod.rs` (`open_url_in_browser` is also re-exported from `jean_core`).

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

#### Keyboard Affordances in Web/Mobile

Keyboard-only affordances are native-desktop only by default:

- Hide `<Kbd>` shortcut hints in web access and mobile views unless the shortcut is explicitly useful there.
- Disable matching keyboard-only default actions in web access/mobile (examples: toast default action `Alt+Enter`, unread session mark-read `R`).
- Keep the click/tap action available; only gate the desktop keyboard hint/handler.
- Use `isNativeApp()` plus `useIsMobile()`/viewport width for gating, and add tests for native desktop, web access, and mobile.

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

1. **`src/types/preferences.ts`** — Add to `ClaudeModel` type union and `modelOptions` array (full labels like "Claude Fable 5.1" or "Claude Sonnet 4.6"). Current first-party Claude Code model IDs use API-style names such as `claude-fable-5-1`, `claude-opus-4-8[1m]`, and `claude-sonnet-4-6[1m]`; legacy/provider aliases may still use `opus`, `sonnet`, or `haiku`.
2. **`src/store/chat-store.ts`** — Add to duplicated `ClaudeModel` type union (line ~27)
3. **`src/components/chat/ChatToolbar.tsx`** — Add to `MODEL_OPTIONS` array (short labels like "Sonnet 4.6")

No Rust changes needed — model is stored as `String` in `AppPreferences` and passed directly to `--model` CLI flag.

#### Adding a New AI Backend

When adding a backend like Claude, Codex, OpenCode, Cursor, Pi, Command Code, or a future CLI/API backend, verify the integration is complete across Rust, TypeScript, UI, persistence, and web access.

**Backend capability classification:**

- [ ] Classify transport shape: persistent server/API, streaming CLI, final-output CLI, or non-chat helper
- [ ] Document capability flags: streaming, structured tool calls, resume/session id, cancellation, interactive approvals, MCP, model listing, usage, images/files
- [ ] Define MVP fallback behavior for unsupported capabilities before wiring UI affordances
- [ ] If backend is final-output-only, emit one synthetic final `chat:chunk` and persist Jean-managed transcript/context
- [ ] If backend has no resume/session id, do not fake resume support; store Jean session id only
- [ ] If backend has no structured tool events, skip tool-call UI or synthesize only safe high-level placeholders

**Backend identity and preferences:**

- [ ] Add backend enum/type in Rust (`src-tauri/src/chat/types.rs`) and TypeScript (`src/types/chat.ts`, `src/types/preferences.ts`)
- [ ] Add backend label/icon/model options (`src/components/ui/backend-label.tsx`, `src/components/icons/`, `ChatToolbar.tsx`)
- [ ] Add persisted preferences for default backend, selected model, reasoning/effort, source (`jean` vs `path`) when applicable
- [ ] Add project-level `default_backend` support and build/yolo backend/model/effort overrides
- [ ] Keep persisted preference fields in `snake_case` and provide serde/default migration safety

**Install, status, auth, and login:**

- [ ] Add CLI module (`src-tauri/src/<backend>_cli/`) with config/status/auth/install/update commands as needed
- [ ] Avoid binary-name ambiguity; support canonical binary and documented aliases when applicable (e.g. `cmd`, `command-code`)
- [ ] For npm-distributed CLIs, decide PATH-only vs Jean-managed npm install/update/uninstall before adding Settings controls
- [ ] Detect whether backend is installed before checking auth
- [ ] Add auth status command and frontend hook/types (e.g. `check_<backend>_auth`, `use<Backend>CliAuth`, `src/types/<backend>-cli.ts`)
- [ ] Auth result distinguishes installed+authenticated, installed+unauthenticated, not installed, command failed, and unknown/error
- [ ] Add login/relogin commands if the backend supports them
- [ ] If login requires terminal/browser, open the terminal login command, auth URL, or backend-native login flow
- [ ] Add Settings → General login/relogin buttons with loading state and toast feedback
- [ ] Re-fetch auth status after login/relogin
- [ ] Include backend auth readiness in onboarding; do not mark backend ready unless installed and authenticated
- [ ] Support both Jean-managed binary and system PATH binary login flows
- [ ] Register every status/auth/login command in both `src-tauri/src/lib.rs` and `src-tauri/src/http_server/dispatch.rs`
- [ ] Add tests/mocks for authenticated, unauthenticated, not installed, login failure, and `jean` vs `path` source

**Main chat execution:**

- [ ] Create execution module (`src-tauri/src/chat/<backend>.rs`) and export it from `chat/mod.rs`
- [ ] Return the common response shape: content, backend resume id, tool calls, content blocks, cancelled flag, usage, and error state if needed
- [ ] Route backend in `src-tauri/src/chat/commands.rs` send-message match
- [ ] Store backend resume id on Rust/TS `Session` and persist/restore it
- [ ] Map backend streaming to common events: `chat:chunk`, `chat:tool-use`, `chat:tool-result`, `chat:tool-block`, `chat:thinking`, `chat:done`, `chat:error`, `chat:cancelled`
- [ ] Preserve ordered `ContentBlock[]`, normalize tool call IDs/names, and attach outputs to matching tool calls
- [ ] Add cancellation support in `src-tauri/src/chat/registry.rs` (process kill, interrupt request, or cancel flag)
- [ ] Update run logs, incomplete-run recovery, synthetic plan injection, and session resume behavior

**System prompts, modes, and context:**

- [ ] Assemble prompts with project custom prompt, global system prompt, execution-mode instruction, `RECAP_INSTRUCTION`, language preference, and parallel-execution prompt when enabled
- [ ] Use the backend-native system prompt mechanism when available; otherwise use a safe fallback
- [ ] Map Jean execution modes (`plan`, `build`, `yolo`) to backend-native sandbox/approval controls
- [ ] Update `getSupportedExecutionModes`, `isExecutionModeSupported`, and `normalizeExecutionModeForBackend`
- [ ] Support backend-native plan tool/approval flow or synthesize a Jean-compatible plan tool call
- [ ] Apply build/yolo backend/model/effort overrides when approving plans
- [ ] Merge all relevant context: project/worktree, GitHub issue/PR/security/advisory, Linear issue, saved context files, linked projects, attached files/images, and denied-message re-send context
- [ ] Embed context directly when the backend cannot access external files/APIs

**Permissions, magic prompts, providers, MCP, and UI:**

- [ ] Add permission/user-input approval structs, events, UI, persistence, and approve/deny commands if backend supports them
- [ ] Add one-shot execution support for all magic prompt operations (session naming, context summary, PR content, commit message, code review, resolve conflicts, release notes, investigations, review comments)
- [ ] Add robust structured JSON extraction for one-shot outputs; define the backend-specific strategy (native JSON schema/tool call, strict JSON text, repair pass, or unsupported-with-UI-disable)
- [ ] For non-JSON-capable backends, wrap prompts with strict JSON instructions and implement tolerant extraction/failure messages
- [ ] Update Magic Prompts UI backend/model/default presets and per-prompt backend/provider/model/effort resolution
- [ ] Add provider/profile support if backend supports custom routing; respect project/global/per-prompt provider precedence
- [ ] Add MCP discovery/health/toggle support if backend supports MCP, including settings-pane grouping, chat status dots, and backend-specific auth hints
- [ ] Update frontend chat/settings/onboarding/usage UI and backend-specific pending request components
- [ ] Add backend to favorite models and fast-mode model handling if relevant
- [ ] Update toolbar/model picker behavior for backend tabs, locked sessions, search scoping, keyboard shortcuts, favorites, and fast-mode controls

**Web access, tests, and docs:**

- [ ] Register every new `#[tauri::command]` in both native `generate_handler![]` and WebSocket dispatch
- [ ] Use dispatch helpers (`field`, `field_opt`, `from_field`, `from_field_opt`, `to_value`) and emit cache invalidation for mutations
- [ ] Use `silent_command()` for background processes to avoid Windows console flashes
- [ ] Add Rust tests for parsing, default backend resolution, cancellation, one-shot JSON extraction, and auth/login
- [ ] Add TS/component/E2E tests for preferences, auth/login UI, execution mode normalization, backend selection, plan approval, cancellation, and magic prompt overrides
- [ ] Update developer docs, user docs, troubleshooting, and all comments that list supported backends

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
