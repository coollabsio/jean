# PR #500 review fixes — GitLab provider

Reviewer: @strausmann — https://github.com/coollabsio/jean/pull/500#pullrequestreview-4863126191
Architecture approved. 3 blockers before merge.

All GitLab code lives in `jean-core/src/projects/gitlab_issues.rs`.
Merge path in `jean-core/src/projects/commands.rs::merge_github_pr` (GitLab branch at top).

## Blocker 1 — `create_mr` sends full MR body in the URL query → 414

**Problem:** `create_mr` builds `merge_requests?...&description={pct_encode(body)}`. AI bodies are
1–4 KB; percent-encoding ~triples that. GitLab nginx caps the request line ~8 KB → intermittent
HTTP 414, surfaced as bare `glab api failed: …`. Self-hosted often stricter.

**Fix:** send body params in the POST body, not the URL.
`glab api` verified (`glab api --help`): `--raw-field key=value` adds JSON-encoded **string** params
to the POST body (raw, no `@file`/type coercion — safe for arbitrary text).

- [ ] Add helper `run_glab_api_fields(app, project_path, method, path, fields: &[(&str, &str)])`
      in `gitlab_issues.rs`. Builds `["api", "--method", method, path]` + `["--raw-field", "k=v"]`
      per field. Same env (`GITLAB_HOST`) + same stderr→error mapping as `run_glab_api_method`.
- [ ] Rewrite `create_mr`: `path = "projects/{enc}/merge_requests"` (no query), fields =
      `[source_branch, target_branch, title, description]`. Drop the `pct_encode` of body/title.
- [ ] Leave GET helpers (`run_glab_api` / `run_glab_api_method`) untouched — GETs are tiny.

## Blocker 2 — `merge_mr` has no error path and no merge options

**Problem:** `merge_mr` does `PUT merge_requests/{iid}/merge` and `?`-propagates raw stderr.
GitLab returns 405/409/422 for draft / conflicts / unresolved threads / "pipeline must succeed".
GitHub path (`merge_github_pr`) checks mergeability first and returns actionable errors.
`squash` and `should_remove_source_branch` are also unavailable (GitHub side has merge options).

**Fix (mirror GitHub path, keep it simple):**
- [ ] Pre-merge mergeability check: reuse `fetch_mr_status_raw` before merging. Map to actionable
      errors — draft → "MR is a draft", conflicts (`detailed_merge_status` = `conflict`/`broken_status`)
      → "MR has merge conflicts…", `ci_must_pass` → "Pipeline must succeed…",
      `discussions_not_resolved` → "Unresolved threads…", non-`opened` state → "MR is not open".
- [ ] Merge options: resolve from project settings via one GET
      `projects/{enc}?...` → `squash_option` (`never` ⇒ squash=false, else true) and
      `remove_source_branch_after_merge`. Pass `squash` + `should_remove_source_branch` as
      `--raw-field` on the merge call (use the new `run_glab_api_fields`). Safe fallbacks when
      settings unreadable (squash=false, remove=false).
- [ ] Improve merge error mapping: detect `405`/`409`/`422` in stderr → friendly message instead
      of raw `glab api failed`.

## Blocker 3 — branch behind main / conflicts

- [x] Merge `origin/main` → resolved 4 conflicts + 2 semantic (test prop renames, `&target_branch`).
      Commit `a73a0164`. typecheck ✓, `cargo check -p jean-core` ✓, affected component tests ✓.
- [x] Run full `bun run check:all` green after Blockers 1–2. (fmt drift from merge folded
      into `1c80832e`.)
- [ ] Push branch. (awaiting user)

## Status
- [x] Blocker 1 — `3738e78b`
- [x] Blocker 2 — `f6e7f70b` (+ tests)
- [x] check:all green

## Tests
- [ ] Unit: squash-option resolution (`never`→false, `always`/`default_*`→true) — pure fn, mirror
      `resolve_merge_flag_from_repo_settings` test pattern.
- [ ] Unit: merge error-code mapping (405/409/422 → friendly strings).
- [ ] Verify `create_mr` builds `--raw-field` args (no query string) — arg-builder unit test.

## Notes
- Reviewer confirmed asset naming, releases API, command registration, `hasBackend` all OK — no action.
- The 8× `is_gitlab_project()` guards are acceptable for 2 providers (reviewer agrees); a 3rd would
  want a trait. Out of scope for this PR.
