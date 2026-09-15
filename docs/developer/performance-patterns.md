# Performance Patterns

### The `getState()` Pattern (Critical)

**Problem**: Subscribing to frequently-changing store data in component callbacks causes render cascades.

**Solution**: Subscribe only to data that should trigger re-renders. For callbacks that need current state, use `getState()`.

```typescript
// ❌ BAD: Causes render cascade on every keystroke
const { currentFile, isDirty, saveFile } = useEditorStore()

const handleSave = useCallback(() => {
  if (currentFile && isDirty) {
    void saveFile()
  }
}, [currentFile, isDirty, saveFile]) // Re-creates on every change!

// ✅ GOOD: No cascade, stable callback
const { setEditorContent } = useEditorStore() // Only subscribe to needed actions

const handleSave = useCallback(() => {
  const { currentFile, isDirty, saveFile } = useEditorStore.getState()
  if (currentFile && isDirty) {
    void saveFile()
  }
}, []) // Stable dependency array
```

### When to Use `getState()` Pattern

1. **In useCallback dependencies**: When you need current state but don't want re-renders
2. **In event handlers**: For accessing latest state without subscriptions
3. **In useEffect with empty deps**: When you need current state on mount only
4. **In async operations**: When state might change during execution

### Store Subscription Optimization

```typescript
// ❌ BAD: Object destructuring triggers re-renders
const { currentFile } = useEditorStore()

// ✅ GOOD: Primitive selectors only change when needed
const hasCurrentFile = useEditorStore(state => !!state.currentFile)
const currentFileName = useEditorStore(state => state.currentFile?.name)
```

### CSS Visibility vs Conditional Rendering

For stateful UI components (like `react-resizable-panels`), use CSS visibility:

```typescript
// ❌ BAD: Conditional rendering breaks stateful components
{sidebarVisible ? <ResizablePanel /> : null}

// ✅ GOOD: CSS visibility preserves component tree
<ResizablePanel className={sidebarVisible ? '' : 'hidden'} />
```

### Strategic React.memo Placement

Use React.memo to break render cascades at component boundaries:

```typescript
// ✅ GOOD: Breaks cascade propagation
const EditorArea = React.memo(({ panelVisible }) => {
  // Component only re-renders when panelVisible changes
  // Not affected by parent re-renders from unrelated state
})
```

---

### Store no-op guards on hot UI paths

Zustand `set()` notifies subscribers even for logically unchanged values. On hot app surfaces (sidebar rows, chat session state, modal visibility, canvas state), guard primitive/record setters before allocating new objects:

```typescript
set(state => (state.modalOpen === open ? state : { modalOpen: open }))
```

For per-session/worktree records, preserve existing object references when the target value is unchanged. This is especially important for selectors used by `ChatWindow`, `WorktreeItem`, and `ProjectCanvasView`.

### Sidebar row selectors should return primitives

Rows rendered many times (for example `WorktreeItem`) should not subscribe to full global maps like `activeToolCalls`, `sessionWorktreeMap`, or `sendingSessionIds` unless they render the whole map. Prefer a selector that computes and returns the row's primitive status:

```typescript
const isWaiting = useChatStore(state => {
  for (const [sessionId, calls] of Object.entries(state.activeToolCalls)) {
    if (state.sessionWorktreeMap[sessionId] !== worktreeId) continue
    if (calls.some(isWaitingCall)) return true
  }
  return false
})
```

This still re-evaluates on store updates, but unaffected rows avoid re-rendering because their selected boolean remains equal.

### Lazy project data queries

Sidebar rows may render for every project, but they must not load every
project's worktrees or sessions. Use the lightweight project-list summary for
row affordances such as worktree counts and base-session presence. Gate the
full worktree query behind the selected/expanded project, and keep session-list
bootstrap in the project canvas only.

Global indicators should use scalar or summary commands. For example, the
unread badge uses a count-only query; the full cross-project session query is
enabled only while the unread popover is open. TanStack Query garbage
collection is not a substitute for `enabled`: an active observer keeps its
data live regardless of `gcTime`.

When a view creates one query definition per worktree, memoize that definitions
array from the worktree list. Streaming/store updates can re-render the view
without changing the worktree list; rebuilding every `queryKey` and `queryFn`
in that path adds avoidable query-observer diffing.

Unread counts should read compact `SessionUnreadSummary` values from the
worktree session index. Session metadata remains authoritative and updates the
summary only when unread-relevant state changes; indexes written by older
versions are migrated lazily by the count command. This keeps the normal badge
path from deserializing every session's run history while preserving the full
session query for the popover.

### Git-status polling and cache writes

`get_branch_status` runs several Git subprocesses and must not be launched more
than once for the same worktree at a time. Background polling and project
bootstrap use the per-worktree single-flight helper; a duplicate request skips
its work because the in-flight request will emit the result.

Project bootstrap keeps its worker pool bounded and sends completed statuses to
one coordinator, which writes the cached Git values to `projects.json` once per
batch. Individual cached-status updates compare supplied values with the
stored values before saving or emitting project-cache invalidation. Frontend
status listeners use the same meaningful fields and ignore `checked_at`-only
events. Bootstrap events carry a cache-persisted marker so they do not trigger
a second frontend write, preventing stable polling from causing React
notifications and disk writes.

The global sweep list should be limited to worktrees with no cached status yet,
recent user activity, cached local/unpushed changes, or an open PR. Clean,
inactive worktrees are refreshed when their project is opened instead of being
polled continuously in the background.

### Terminal renderer retention

`TerminalPanel` should mount the active worktree's terminal surface only. The
terminal store can retain logical tab metadata, but inactive xterm/Ghostty DOM
surfaces should be detached when switching worktrees. Detached, non-running
renderers are capped by `MAX_DETACHED_TERMINAL_INSTANCES`; running PTYs are
rehydrated later, but their detached renderer is evicted after
`RUNNING_RENDERER_IDLE_MS`. The logical PTY stays alive and output received
while it is detached is retained in the bounded `DETACHED_OUTPUT_BUFFER_CHARS`
buffer; the visible screen is snapshotted before disposal so a quiet prompt is
not recreated as a blank terminal. Keep renderer scrollback bounded with
`TERMINAL_SCROLLBACK_LINES` so output-heavy shells do not grow their
browser-side buffers indefinitely.

### Canvas viewport containment

Project canvas sections use `content-visibility: auto` with an intrinsic size.
This lets the browser skip layout and paint work for worktrees far outside the
viewport while keeping their DOM nodes available for drag-and-drop and keyboard
navigation. It is a low-risk intermediate optimization until full variable-row
virtualization can account for the canvas's reorder and selection behavior.

Canvas session-card derivation is cached by immutable session object and
session-specific live-state entries. An update for one session therefore does
not rescan message history for every other worktree, and the weak cache keys do
not retain sessions after their query data is released.

Canvas rows keep their DOM nodes mounted for drag-and-drop and keyboard
navigation, but Git-status queries and run-terminal subscriptions are gated by
an `IntersectionObserver` with a small look-ahead margin. Rows far outside the
viewport therefore do not keep per-row live observers or terminal-store scans
active; status data remains in the query cache and is read immediately when a
row becomes visible again. Event-backed Git-status entries use the same
two-minute inactive cache horizon as session data so status for abandoned
projects is not retained indefinitely.

### Session and worktree state cleanup

Closing or archiving a session must remove every session-keyed record in the
chat store, including drafts, streaming blocks, queues, permissions, review
results, model settings, and status flags. Worktree lifecycle cleanup also
removes session-to-worktree mappings, paths, loading state, terminal metadata,
auto-open/auto-investigate markers, and session scroll snapshots. Keep this in
centralized idempotent cleanup actions so deletion events received from another
client cannot leave stale state behind. Remove the corresponding TanStack
Query session caches at the same lifecycle boundary; invalidation alone keeps
the old payload in memory until garbage collection.
