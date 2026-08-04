# Server agent browser (manual login + AI control)

## Summary

Make a real browser available to AI sessions on **jean-server** / headless Web
Access: user logs in manually once, agents reuse the same persistent profile
via MCP (Playwright or equivalent).

Design: `docs/developer/server-agent-browser.md`

## Phase 1 (MVP product)

- [x] Engine: vercel-labs/agent-browser (Chromium + Jean profile)
- [x] App-data profile dir: `$app_data/agent-browser/profile`
- [x] Commands: `get_agent_browser_status`, `ensure_agent_browser_profile`,
      `install_agent_browser` (npm + Chromium), `install_agent_browser_mcp`
- [x] MCP config writers for Claude/Codex/OpenCode/Cursor/Grok/Kimi
- [x] Settings → MCP → Agent Browser UI
- [x] Auto-enable MCP in preferences on install
- [x] Register commands in `dispatch.rs` (native + web access)
- [x] Unit tests for snippets / config upsert
- [ ] Optional: destructive reset profile (confirm)

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
