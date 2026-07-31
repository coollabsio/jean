# Server agent browser (manual login + AI control)

## Summary

Make a real browser available to AI sessions on **jean-server** / headless Web
Access: user logs in manually once, agents reuse the same persistent profile
via MCP (Playwright or equivalent).

Design: `docs/developer/server-agent-browser.md`

## Phase 1 (MVP product)

- [ ] App-data profile dir: `$app_data/agent-browser/profile`
- [ ] Commands: status, install MCP config for selected backends, optional
      reset profile (confirm)
- [ ] Reuse `jean_mcp_config` writers for safe Claude/Codex/OpenCode/… upsert
- [ ] Preferences + Settings UI (Integrations or Experimental)
- [ ] Docs: operator setup (Node, Playwright browsers, headed vs headless)
- [ ] Register commands in `lib.rs` generate_handler **and** `dispatch.rs`

## Phase 2

- [ ] Managed Chromium/CDP lifecycle owned by Jean
- [ ] Single-instance lock on user-data-dir
- [ ] Session cancel cleans up browser MCP children

## Phase 3

- [ ] Xvfb + noVNC (or equivalent) remote view inside Web Access
- [ ] Token-gated “Agent browser” panel for manual login / watch
- [ ] Origin allowlist + action audit log (optional)

## Acceptance (Phase 1)

1. On jean-server host, “Install agent browser MCP” writes backend config with
   `--user-data-dir` pointing at Jean profile.
2. User enables MCP for a session, logs in once headed (or via remote display).
3. Subsequent agent turns can open authenticated pages without re-login.
4. Desktop embedded browser + Claude `--chrome` remain unchanged.
