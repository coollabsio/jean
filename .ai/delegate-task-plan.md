# Plan: `delegate_task` for Jean (t3code equivalent + consensus)

Status: PLAN ONLY. Wait for user approval before implementation.

## Goal

Any Jean chat session can call the Jean MCP tool `delegate_task`. Jean then:

1. Makes one or more new child sessions. By default they are in the **current worktree** of the parent.
   As an option, each child gets a new worktree.
2. Sends the task to each child with the backend, model, effort and mode you select.
3. Records the parent → child links.
4. Wakes the parent with the result when the children complete (async). With `mode: "wait"`, the tool blocks.

**Consensus:** one call can send the **same task to 2–5 models** in the current worktree. Jean wakes the parent
**one time**, when all children are complete, with all the answers together. The parent compares the answers
and makes the decision. For a second round, the parent calls `delegate_task` again with the earlier answers in `task`.

Reference: t3code `docs/orchestration-v2/orchestrator-mcp-server.md` and
`packages/contracts/src/orchestratorMcp.ts` (local clone `/tmp/t3src/t3code` @ `5211acfe`).

## Facts found (do not re-scan)

- Tools are defined in `jean-core/src/jean_mcp_core.rs` (`tool_registry_session()` ~319-339).
  Dispatch: `call_tool` (354) → `run_tool` (453).
- The caller session id is `source`. It comes from the env var `JEAN_MCP_SESSION`, which is set per run in
  `chat/commands.rs:3375-3394` (Claude, Grok, Cursor, local Devin, Muse) and in
  `jean_mcp_config::codex_session_config_override` (Codex).
  OpenCode, Pi, Kimi, CommandCode and Antigravity send a fixed label (`manual-dev`/`manual-prod`), not a session id.
- `resolve_session_worktree(app, source)` (`jean_mcp_core.rs:2988`) gives the worktree id and path of the caller.
- The caller's execution mode is not passed to `call_tool`. Read it with
  `chat::claude_permissions::active_run(app, source)` or with `storage::load_metadata(..).selected_execution_mode`.
- `RATE_LIMITED_TOOLS` (`jean_mcp_core.rs:29-67`) applies the depth limit `jean_mcp_max_depth` and the rate limit.
- Do NOT use MCP `create_session`: it reuses empty sessions. Call `crate::chat::create_session`
  (`chat/commands.rs:1066`) directly.
- `crate::chat::send_chat_message` (`commands.rs:2592`) is headless. It rejects a busy session.
  `crate::chat::enqueue_message` (`commands.rs:9717`) is safe for a busy session (the queue drains when idle).
- The agent wake path (`agents/engine.rs` `start` 65-83, `on_run_ended` 118, `tick` 212, `check_delegation` 297,
  `deliver` 934) needs an `agent_id` (NOT NULL FK). We cannot use it for normal sessions.
  We can reuse: the `chat:done|error|cancelled` listeners, `outcome_status` (281), `last_reply` (386), `truncate`,
  and the logic that waits while the target is busy.
- Sessions are JSON files (`chat/storage.rs`). `agents.db` is SQLite with a migration list (`agents/db.rs` `MIGRATIONS`).
- `projects::create_worktree` returns before the worktree is ready. Use `wait_for_worktree_ready`
  (`jean_mcp_core.rs:2646`) and pass the parent `Worktree.branch` as `baseBranch`.
- The MCP stdio proxy has a 120 s response timeout (`jean_mcp_stdio.rs:22`). Backend CLIs also have their own
  MCP tool timeouts. Thus the wait mode must stay well below 120 s.
- The rollback pattern for a failed spawn: `agents/subagents.rs:154-174`.

## Design decisions

| # | Decision | Reason |
|---|---|---|
| D1 | The source of truth is a new SQLite table `delegated_tasks` in `agents.db` (new migration step at the end of `MIGRATIONS`). | Atomic idempotency (UNIQUE key), status queries, restart recovery. |
| D2 | The child `SessionMetadata` gets `delegated_from: Option<DelegatedFrom { parent_session_id, task_id, group_id }>` (`#[serde(default)]`). | The UI can show "Delegated from …" without a DB call. |
| D3 | Async is the default. `wait` is capped at 100 s. A timeout does not cancel the children, and the auto-wake still occurs. | The proxy's 120 s limit and the CLI tool timeouts. |
| D4 | The parent wake uses `enqueue_message` with the prefix `[Jean task update]`. | Works when the parent is busy. Uses the existing queue drain. |
| D5 | Mode ceiling: the child mode must be ≤ the parent mode. A higher explicit mode → error. An inherited mode → step down. One function `mode_rank()`. | No privilege escalation (same as t3code). |
| D6 | Depth: add `delegate_task` to `RATE_LIMITED_TOOLS`. Use the existing `jean_mcp_max_depth`. | Use what exists. |
| D7 | Backends without a real `source` → typed error `parent_unknown`. Phase 5 fixes them. | No wrong parent links. |
| D8 | Follow-ups to one child use `send_chat_message` on `childSessionId`. A new consensus round is a new `delegate_task`. | No new tool. |
| D9 | v1 refuses `delegate_task` from agent sessions (they keep `spawn_subagent`). | Two wake paths in one session would conflict. Open question Q1. |
| D10 | **The default is `isolation: "shared"`: children work in the parent's current worktree** (same path, same branch, they see uncommitted edits). | The user asked for it: all models look at the same code. |
| D11 | **Consensus = `targets` array (2–5).** One call makes one child per target and one `group_id`. Jean wakes the parent one time, when all children of the group are terminal. | One combined result is easier for the parent to compare than 5 separate wakes. |
| D12 | **Shared worktree + 2 or more targets → children run in `plan` mode** (read-only), unless the call sets `isolation: "worktree"`. An explicit `build`/`yolo` with shared + 2 or more targets → error `shared_write_conflict`. | Two models that edit the same files at the same time corrupt the work. A consensus is about answers, not edits. |
| D13 | Each child in a group gets the same `task` text. Jean adds one line: "Other models get the same task. Give your own independent answer." Jean does not show one child's answer to another child in the same round. | Independent answers make the consensus useful. |
| D14 | The parent is the judge. Jean does not make an automatic vote or merge. | Simple. The parent model already has the context. |

## Contract (write this first; all phases use it)

MCP tool `delegate_task` input (camelCase):
```
task: string (required)              // each child gets ONLY this text + role line + consensus line (D13)
title?: string                       // child session name; Jean adds " · <model>" for each target
role?: implementation|research|review|design|test|general
backend?, model?, effortLevel?, thinkingLevel?, customProfileName?   // one child; default: inherit parent
targets?: [{ backend?, model?, effortLevel?, thinkingLevel?, customProfileName? }]  // 2–5 → consensus group
                                     // do not use with the single-target fields above
executionMode?: inherit|plan|build|yolo   // default inherit; ceiling = parent (D5); group rule D12
isolation?: shared|worktree          // default shared = parent's current worktree (D10)
mode?: async|wait                    // default async
timeoutSec?: number                  // wait only; default and max 100
clientRequestId?: string             // idempotent per parent session (covers the whole group)
```
Result:
```
groupId: string|null,
tasks: [{ taskId, childSessionId, childWorktreeId, backend, model, executionMode,
          status: queued|running|waiting_for_input|completed|failed|cancelled,
          summary: string|null }],
waitTimedOut: bool,
next: string   // for example "End your turn. Jean sends all results together as a [Jean task update]."
```
More MCP tools: `delegated_task_status { taskId | groupId }`, `delegated_task_cancel { taskId | groupId, reason? }`.
Typed errors: `parent_unknown`, `parent_not_active`, `mode_escalation_denied`, `shared_write_conflict`,
`backend_unavailable`, `model_unavailable`, `depth_exceeded`, `too_many_targets`, `task_not_found`,
`agent_session_unsupported`.

Wake message for a group (one message):
```
[Jean task update] Automatic message from Jean, not from the user.
Consensus group <groupId>: 3 of 3 complete.
## Claude Opus 5.5 (completed) — session <link>
<summary>
## Codex gpt-5.5 (completed) — session <link>
<summary>
## Grok 5 (failed) — <error>
Compare the answers and decide. For another round, call delegate_task again with these answers in the task.
```

Table `delegated_tasks`:
```
id TEXT PK, group_id NULL, child_index INTEGER (0 for a single task), parent_session_id, parent_worktree_id, child_session_id, child_worktree_id,
client_request_id NULL, role NULL, backend, model NULL, execution_mode, status, summary NULL, error NULL,
created_at, ended_at NULL, check_after NULL, delivered_at NULL,
UNIQUE(parent_session_id, client_request_id, child_index)
```

Tauri command (UI): `list_delegated_tasks { sessionId }` → the tasks where the session is the parent, or the child.
Register it in `lib.rs` `generate_handler![]` AND in `http_server/dispatch.rs`.

## Phases

Phases 2 and 4 can run in parallel after phase 1. Phase 3 needs phase 2.

### Phase 1: contract and storage
- [ ] Migration + `jean-core/src/agents/delegated_tasks.rs`: insert group (all rows in one transaction; idempotent → return existing rows),
      get, list_by_session, list_by_group, mark_ended, due_checks, group_complete, mark_delivered, requeue_running_on_startup.
- [ ] `DelegatedFrom` on `SessionMetadata` (Rust + `src/types/chat.ts`), serde default.
- [ ] `mode_rank()` + `resolve_child_mode(parent, requested, isolation, target_count) -> Result<mode, ToolError>` (D5 + D12).
      Read `docs/developer/permissions.md` for the order of `supervised` and `auto`.
- [ ] Rust unit tests: idempotency, mode ceiling (each pair), D12 (shared + 2 targets → plan; explicit build → error), migration on an old DB.

### Phase 2: the MCP tools
- [ ] Tool definitions in `tool_registry_session()`. The description says: use `targets` for a second opinion or a consensus;
      end the turn after async.
- [ ] `delegate_task` handler:
      1. Check `source` (D7) and the agent session (D9). Validate `targets` (2–5, not with single-target fields).
      2. Look up `clientRequestId`. If rows exist, return them.
      3. Resolve the parent worktree and mode, then the child mode (D5, D12).
      4. Shared: use the parent's `worktree_id` and path. Worktree: one new worktree per child, based on the parent's
         **HEAD commit sha** (same as t3code: `resolveCommit(HEAD)` in the parent checkout, `startFromOrigin: false`),
         on a new temporary branch, + `wait_for_worktree_ready` + the project setup script.
         Check first that `projects::create_worktree` accepts a commit sha as the base (not only a branch name).
         On a failure before the child starts: remove the new worktree. After the child starts: keep it.
         Jean does not merge the child's work back. The parent or the user compares, merges or opens a PR.
      5. For each target: `chat::create_session`, write `delegated_from`.
      6. Insert all rows in one transaction, then spawn `send_chat_message` for each child (in parallel).
      7. If a step fails, roll back all sessions, worktrees and rows of this call.
- [ ] Wait mode: poll the rows every 1 s up to `timeoutSec`. End early when all are terminal, or when one child waits for input.
- [ ] `delegated_task_status`, `delegated_task_cancel` (by task or by group; recursive to grandchildren). The parent only.
- [ ] Add `delegate_task` to `RATE_LIMITED_TOOLS`.

### Phase 3: wake and delivery
- [ ] A listener on `chat:done|error|cancelled`. If the session is a child in `delegated_tasks` → `mark_ended`,
      set `check_after = now + CHECK_DELAY_SECS`, nudge.
- [ ] A tick step: for each due row, wait while the child is busy, then set status (`outcome_status`) and summary (`last_reply`).
      Single task → deliver at once. Group → deliver only when `group_complete`, as one combined message (format above).
      `enqueue_message` to the parent. Skip when the parent was deleted. Set `delivered_at` on all rows (no double delivery).
- [ ] A child that waits for input: deliver one "child needs input" update at once (do not wait for the group).
- [ ] Startup: `requeue_running_on_startup`.
- [ ] If a `wait` call already returned the full result, mark `delivered_at` so the parent does not wake again.
- [ ] Rust tests: group waits for all, combined message format, one failed child still completes the group,
      no double delivery, deleted parent, restart recovery.

### Phase 4: UI (desktop, web access, mobile)
- [ ] Hook `useDelegatedTasks(sessionId)` (TanStack Query → `list_delegated_tasks`). Invalidate on `chat:done` and on `[Jean task update]`.
- [ ] Parent: a card for the `delegate_task` tool call. Single task: status, backend/model, "Open child session".
      Group: one row per model with status and link, plus "2 of 3 complete".
- [ ] Parent: render `[Jean task update]` as a compact "Task result" / "Consensus results" block with one section per model
      (next to `isAgentUpdateMessage` in `chat/message-content-utils.ts`).
- [ ] Child: a header line "Delegated from <parent session>" (+ "consensus 1 of 3").
- [ ] Mobile views: same card, result block and link (separate components; check them).
- [ ] TS tests: only the message parse/classify logic.

### Phase 5: other backends (later, separate PR)
- [ ] Inject `JEAN_MCP_SESSION` per run for OpenCode, Pi, Kimi, CommandCode and Antigravity, so that D7 no longer blocks them.

### Phase 6: docs and checks
- [ ] `docs/developer/delegated-tasks.md` (flow, table, rules, consensus). Link from `architecture-guide.md:466`.
- [ ] `cargo test -p jean-core delegated` + `bun run check:all` one time at the end.
- [ ] Manual smoke test:
      1. A Claude parent delegates a review to Codex (async). The parent wakes with the result.
      2. A Claude parent asks Codex + Grok + Claude for a consensus in the current worktree. All three run in plan mode
         in the same worktree. The parent wakes one time with three answers.
      3. The same consensus with `executionMode: build` and shared → `shared_write_conflict`.
      4. A plan-mode parent asks for `yolo` → `mode_escalation_denied`.

## Open questions
- Q1: Allow `delegate_task` in agent sessions too (D9)?
- Q2: Wait cap of 100 s acceptable?
- Q3: Remote targets (t3code `environmentId`) out of scope for v1?
- Q4: Max 5 targets per consensus group acceptable?

## Review
(fill after implementation)
