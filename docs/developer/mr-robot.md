# Mr. Robot workspace

## Separate automation from normal work

`Worktree.origin == auto_fix` is the ownership boundary for automation. All
sessions in that worktree belong to its Mr. Robot view, including manually
created follow-up sessions. Do not classify ownership from names, issue
numbers, or session status.

- `matchesCanvasFilterTab` permits automation worktrees only in `auto_fix`.
  This applies before session search, and includes pending and failed creation.
- Project canvas label tabs exclude automation worktrees from their labels and
  counts.
- `ProjectTreeItem` removes automation worktrees before sidebar search,
  counts, and row rendering.
- `get_recent_worktrees` excludes automation before sorting and pagination.
  The frontend also filters responses from older servers. Explicit pins do not
  override this boundary.
- Keep the complete worktree query cache intact. Mr. Robot, archive, deletion,
  chat recovery, and background jobs still need those resources.

## Status and actions

`MrRobotPanel` is shared by desktop and mobile ProjectCanvasView. Its queries
and mutations resolve the owning project server. Summary counts use all Mr.
Robot worktrees, independent of canvas search. Row actions open the exact
session that needs attention. Existing plan approval and chat controls remain
inside the session, so the panel does not add a second approval path.

Pause uses the existing persisted `auto_fix_settings.enabled` switch. It stops
future scans and automatic plan approval; it does not cancel active sessions.
Resume preserves the other settings. An unconfigured project opens setup
instead of choosing a model silently.

## Backend commands

Native `dispatch_core_command` and Web Access share
`jean-core/src/http_server/dispatch.rs`. No separate Tauri command registration
is needed for these core dispatch commands.

- `get_auto_fix_status`: scan state, timing, failures, scan summary, and recent
  activity. `activeNow` uses the owning server's local clock.
- `request_auto_fix_scan`: schedules a scan on the next scheduler tick. It
  rejects disabled projects, inactive hours, an active scan, and GitHub
  rate-limit backoff. Normal capacity, label, and duplicate-start guards remain.
- `preview_auto_fix_issues`: reads up to 1,000 open GitHub issue numbers and
  labels without starting work. The preview uses the scheduler's label
  normalization and issue selection. It explains exclusions, existing
  worktrees, in-progress starts, exhausted retries, capacity, and scan limits.
- `clear_auto_fix_failures`: clears failed starts for a later scheduler retry;
  it does not rerun an existing chat turn.

The scheduler records at most 30 events per project, newest first. It records
scans, planning/build starts, turn completion/cancellation, and errors. Like
the existing runtime status, history resets when the server restarts. The UI
states this limit. Durable worktree and session history remain unchanged.

A scan guard releases runtime scan state on every exit, including errors and
full capacity. Manual scan requests cannot clear rate-limit backoff.

## Verification

- Unit tests: `bun run test:run src/components/dashboard/canvas-worktree-filters.test.ts src/components/dashboard/mr-robot-state.test.ts src/services/recent-worktrees.test.ts`
- Rust scheduler: `cargo test --manifest-path jean-core/Cargo.toml auto_fix::scheduler::tests --lib`
- Browser: `bunx playwright test e2e/tests/mr-robot.spec.ts --config e2e/playwright.config.ts`
  Uses the repository E2E mock backend at `http://localhost:1421`, on desktop
  and mobile viewports. Real GitHub/AI execution still needs a configured Jean
  instance.

References:

- [TanStack Query mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations)
- [Tauri v2 frontend commands](https://v2.tauri.app/develop/calling-rust/)
