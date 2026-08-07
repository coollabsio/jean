# Audit: every path that executes a magic prompt

Written after the Investigate-Failure bug: `handleInvestigateWorkflowRun` was
wired for terminal surface, but the button actually runs a **duplicated copy** in
`WorkflowRunsModal.tsx`. Assume duplication until proven otherwise — "I wired the
handler" is not evidence the button uses it.

## How to tell live from dead

`magic-command` values actually dispatched anywhere in src:

    investigate, resolve-conflicts, review-comments, open-pr,
    revert-last-commit, fork-session

Cases handled in `useMagicCommands.ts` but **never dispatched as an event**
(so reachable only if called directly as a prop):

    commit, commit-and-push, investigate-workflow-run, merge, merge-pr,
    pull, push, review, load-context, save-context, linked-projects,
    inject-session

## Inventory

| # | Prompt | Executing path | Surface-aware? |
|---|---|---|---|
| 1 | Investigate issue/PR/security/advisory/linear/sentry | `useInvestigateHandlers.handleInvestigate` — event `investigate` IS dispatched | YES |
| 2 | Investigate workflow run (M button) | `WorkflowRunsModal.tsx` own createSession+sendMessage | YES (fixed) |
| 3 | Investigate workflow run (hook copy) | `useInvestigateHandlers.handleInvestigateWorkflowRun` | wired, but **DEAD** — no dispatcher |
| 4 | Auto-investigate on worktree create | `useBackgroundInvestigation.ts` -> Rust `start_background_investigation` | **NO** |
| 5 | Resolve conflicts (PR branch) | `useGitOperations.handleResolvePrConflicts` | YES |
| 6 | Resolve conflicts (plain) | `useGitOperations.handleResolveConflicts` | **NO** |
| 7 | Review comments | `useInvestigateHandlers.handleReviewComments`, dispatched from `ReviewCommentsDialog.tsx:558` | **NO** |
| 8 | Final review | `useGitOperations.handleFinalReview` | **NO** |
| 9 | Code review | `use-command-context.ts:625` -> Rust `start_review_job` | **NO** — needs the 2b file bridge |
| 10 | Queued messages | `useQueueProcessor.ts:162` sendMessage | N/A — replays user messages |
| 11 | Update PR | `UpdatePrDialog.tsx:189` sendMessage | **NO** (not in the 11 surface keys) |

## Headless-only by design (no surface key, correct)

| Prompt | Path |
|---|---|
| Commit message | `GitDiffModal.tsx:374` / `useGitOperations` -> `startCommitJob` |
| PR content | `use-command-context.ts:857` -> `generate_*` |
| Context summary | `useContextOperations.ts:83` -> `generate_*` |
| Release notes | `ReleaseNotesDialog.tsx` -> `generate_release_notes` |
| Session naming | jean-core internal |
| Load-context summaries | `useLoadContextHandlers.ts:822` -> `generate_*` |

Jean consumes each of these as a **string**. A TUI returns a screen. Excluded
when the file bridge was scoped to code review only.

## Done since the audit

- 4 — background investigation: guarded before `start_background_investigation`.
- 6 — plain resolve-conflicts: guarded, prompt hoisted above session creation.
- 7 — review comments: one terminal per prompt, mirroring one-session-per-prompt.
- 8 — final review: guarded before `create_session`.
- Refactor: the decision moved to `src/lib/magic-prompt-surface.ts`
  (`maybeRunMagicPromptInTerminal`), hook-free so non-React callers share it.
  `useMagicPromptRunner` is now a thin wrapper supplying the React Query
  session mutation. Tests moved to `src/lib/magic-prompt-surface.test.ts` —
  the old hook test mocked `launchMagicPromptTerminal`, which stopped working
  once the call became module-internal.

## Terminal Magic button (done)

`src/components/chat/TerminalMagicButton.tsx`, mounted in `SessionChatModal`
beside terminal/browser/run. Renders null unless the session's
`sessionPrimarySurface` is `terminal` — chat keeps its composer button.

Opens the existing `MagicModal` (`setMagicModalOpen(true)`) rather than a
parallel menu. A second menu was built first and thrown away: it could only
offer Final Review and Resolve Conflicts, because every investigate prompt
interpolates loaded issue/PR/alert context. Reusing the palette keeps one set of
commands and shortcuts, and every command already routed through a
surface-aware handler works from a terminal session for free.

## Model passing (done)

Terminal runs used to launch with the CLI's *default* model, ignoring the
magic-prompt model setting. Now resolved by a new Rust command
`resolve_terminal_model_args(backend, model) -> Vec<String>`
(`jean-core/src/terminal/commands.rs`), registered in `http_server/dispatch.rs`.

Normalization stays in Rust on purpose — each backend's rules are non-obvious
and already implemented there for headless runs:

| Backend | Rule |
|---|---|
| claude | id verbatim, incl. `[1m]`; only `-fast` stripped |
| codex | `split_fast_model` remaps fast variants |
| opencode | keeps `opencode/` when opencode IS the provider; strips it for `opencode/ollama/Qwen` |
| grok / kimi / commandcode | strip prefix; `*/default` means CLI default |
| cursor / pi | no verified flag — left to the CLI |

Four private fns became `pub(crate)` to allow reuse. 10 tests in
`terminal::commands::tests`.

## Remaining work

- [ ] 4 — background investigation: needs the guard before
      `start_background_investigation`, or the Rust command needs a surface arg.
      This one fires on worktree creation from an issue/PR, so it is high traffic.
- [ ] 6, 7, 8 — plain resolve-conflicts, review comments, final review.
- [ ] 9 — code review via the section 2b bridge.
- [ ] 3 — delete the dead handler or re-point `WorkflowRunsModal` at it, so the
      duplication cannot drift again.
- [ ] 11 — decide whether Update PR deserves a surface key.
