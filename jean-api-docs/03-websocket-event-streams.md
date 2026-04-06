# WebSocket Event Streams

This file lists concrete event channels emitted with `emit_all(...)` and delivered to web clients.

Generic event frame shape:

```json
{
  "type": "event",
  "event": "chat:chunk",
  "payload": {}
}
```

## Chat stream events

### `chat:sending`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "..."
}
```

### `chat:chunk`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "content": "partial streamed text"
}
```

### `chat:tool_use`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "id": "tool-call-id",
  "name": "Read|Edit|Bash|...",
  "input": {},
  "parent_tool_use_id": "optional"
}
```

### `chat:tool_block`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "tool_call_id": "..."
}
```

### `chat:thinking`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "content": "thinking text"
}
```

### `chat:tool_result`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "tool_use_id": "...",
  "output": "tool stdout/result"
}
```

### `chat:permission_denied`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "denials": [
    {
      "tool_name": "Bash",
      "tool_use_id": "...",
      "tool_input": {},
      "rpc_id": 123
    }
  ]
}
```

### `chat:compacting`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "..."
}
```

### `chat:compacted`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "metadata": {
    "trigger": "manual|auto",
    "pre_tokens": 12345
  }
}
```

### `chat:done`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "..."
}
```

### `chat:error`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "error": "error text"
}
```

### `chat:cancelled`
Payload:
```json
{
  "session_id": "...",
  "worktree_id": "...",
  "undo_send": true
}
```

## Worktree lifecycle events

### `worktree:creating`
```json
{
  "id": "pending-worktree-id",
  "project_id": "...",
  "name": "...",
  "path": "...",
  "branch": "...",
  "pr_number": 123,
  "issue_number": 456
}
```

### `worktree:created`
```json
{
  "worktree": { "id": "...", "project_id": "...", "path": "..." }
}
```

### `worktree:error`
```json
{
  "id": "pending-worktree-id",
  "project_id": "...",
  "error": "..."
}
```

### `worktree:path_exists`
```json
{
  "id": "pending-worktree-id",
  "project_id": "...",
  "path": "...",
  "suggested_name": "...",
  "archived_worktree_id": "optional",
  "archived_worktree_name": "optional"
}
```

### `worktree:branch_exists`
```json
{
  "id": "pending-worktree-id",
  "project_id": "...",
  "branch": "...",
  "suggested_name": "..."
}
```

### `worktree:deleting`
```json
{ "id": "...", "project_id": "..." }
```

### `worktree:delete_error`
```json
{ "id": "...", "project_id": "...", "error": "..." }
```

### `worktree:deleted`
```json
{ "id": "...", "project_id": "..." }
```

### `worktree:archived`
```json
{ "id": "...", "project_id": "..." }
```

### `worktree:unarchived`
```json
{ "worktree": { "id": "...", "project_id": "..." } }
```

### `worktree:permanently_deleted`
```json
{ "id": "...", "project_id": "..." }
```

## Background status events

### `git:status-update`
```json
{
  "worktree_id": "...",
  "current_branch": "...",
  "base_branch": "...",
  "behind_count": 0,
  "ahead_count": 0,
  "has_updates": false,
  "checked_at": 1730000000,
  "uncommitted_added": 0,
  "uncommitted_removed": 0,
  "branch_diff_added": 0,
  "branch_diff_removed": 0,
  "base_branch_ahead_count": 0,
  "base_branch_behind_count": 0,
  "worktree_ahead_count": 0,
  "unpushed_count": 0
}
```

### `pr:status-update`
```json
{
  "worktree_id": "...",
  "pr_number": 123,
  "pr_url": "https://github.com/...",
  "state": "open|closed|merged",
  "is_draft": false,
  "review_decision": "approved|changes_requested|review_required|null",
  "check_status": "success|failure|pending|error|null",
  "display_status": "draft|open|review|merged|closed",
  "mergeable": "mergeable|conflicting|unknown|null",
  "checked_at": 1730000000
}
```

## Naming and sync events

Naming:
- `session-renamed`
- `session-naming-failed`
- `branch-renamed`
- `branch-naming-failed`
- `naming-failed`

State synchronization:
- `cache:invalidate` payload example:
  ```json
  { "keys": ["projects", "sessions"] }
  ```
- `session:setting-changed` payload example:
  ```json
  { "session_id": "...", "key": "model", "value": "opus" }
  ```

## CLI installation progress events

- `claude-cli:install-progress`
- `codex-cli:install-progress`
- `opencode-cli:install-progress`
- `gh-cli:install-progress`

Common payload shape:
```json
{
  "stage": "starting|downloading|extracting|installing|verifying|complete",
  "message": "...",
  "percent": 0
}
```

## Operational note

Event streams are realtime but not strictly lossless for slow clients.
For correctness, reconcile with pull commands (`get_session`, `get_sessions`, `list_worktrees`, etc.) after reconnects.
