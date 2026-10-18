# Server Agent Browser (manual login + AI control)

## Goal

On **jean-server** (and Web Access without a desktop display), let the user
**log into accounts manually once**, then let coding agents **drive the same
browser** for authenticated workflows (Gmail, admin panels, SaaS apps, etc.).

This is **not** Jean's desktop embedded browser (Tauri child Webviews + React
Grab). That path is desktop-only and has no server equivalent.

## Engine choice

**[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)**
(Vercel Labs agent-browser CLI + MCP).

| Piece | Choice |
| --- | --- |
| Automation control plane | `agent-browser` CLI / `agent-browser mcp` |
| Actual browser | Chromium / **Chrome for Testing** (`agent-browser install`) |
| Isolation | One agent-browser session (own Chrome, temp profile) per Jean session |
| Login persistence | Shared restore key `AGENT_BROWSER_RESTORE=jean` (cookies + localStorage) |
| Scope | **Browser use** (web only), not full desktop computer use |

Jean does not reimplement CDP. Jean owns the per-session env, Settings UI, and
writing backend MCP configs.

## What already exists

| Capability | Where | Server-friendly? |
| --- | --- | --- |
| Embedded Browser panel (tabs, grab DOM) | `src-tauri/src/browser/*` | **No** — Tauri Webview |
| Claude Chrome integration (`--chrome`) | `chrome_enabled` prefs | Desktop + Claude extension only |
| Agent browser (this feature) | `jean-core/src/agent_browser/` | **Yes** |
| MCP discovery / enable | Settings → MCP | **Yes** |

## Architecture

```text
┌──────────────────── jean-server host ─────────────────────┐
│                                                           │
│  User (optional remote view later)                        │
│       │                                                   │
│       ▼                                                   │
│  Jean Web Access / Settings                               │
│       │ install MCP                                       │
│       ▼                                                   │
│  Claude/Codex/… session                                   │
│       │ MCP tools (agent-browser)                         │
│       ▼                                                   │
│  agent-browser daemon per session ──► own Chromium        │
│       logins shared via restore key `jean`                │
└───────────────────────────────────────────────────────────┘
```

### Why not re-use the embedded browser?

- jean-server has **no Tauri, WebView, GTK, or display server**.
- Agents need a local automation surface (CDP), not a React-hosted iframe.

### Why agent-browser over Playwright MCP?

- Built for agents (compact snapshots, `@eN` refs, auth helpers).
- First-class persistent profiles and restore/state.
- MCP + CLI dual path for all Jean backends.
- Domain allowlists / content boundaries for safer defaults later.

Claude `--chrome` remains available on **desktop** for users with the Chrome
extension. Prefer agent-browser on **servers** and multi-backend setups.

## Sessions and login persistence

A shared Chromium profile (`--profile`) is locked by one Chrome process, so it
forced every Jean session to share one browser and one active tab: parallel
sessions waited for each other and changed each other's page. Now each Jean
session gets its own agent-browser session:

| Env | Set by | Value |
| --- | --- | --- |
| `AGENT_BROWSER_SESSION` | Jean, per run | `jean-<jean session id>` |
| `AGENT_BROWSER_RESTORE` | MCP entry | `jean` (shared restore key) |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | MCP entry | `900000` (close idle browsers after 15 min) |

- Each session starts its own Chrome with a temporary profile (deleted on close).
  Cost: about 0.5 GB of memory per active session.
- Logins: agent-browser saves cookies + localStorage under the restore key when
  a session's browser closes (also on idle shutdown) and loads the newest saved
  state when the next session starts. A login made in one session reaches
  sessions that start after it closes, not sessions already running.
- Per-run env: Claude (`env_vars` in `chat/claude.rs`), Cursor, Kimi, Grok.
  Codex runs one shared app-server, but starts MCP servers per thread, so
  `thread/start` / `thread/resume` get the dotted config override
  `mcp_servers.agent-browser.env.AGENT_BROWSER_SESSION`. Jean adds it only when
  `~/.codex/config.toml` has the `agent-browser` server, because the override
  alone would create a partial server table that Codex rejects.
- Not isolated: OpenCode (one shared server process) and Antigravity (detached
  spawn without per-run env). They still share one browser session.
- Migration: on start, Jean imports logins from the legacy shared profile
  (`$JEAN_APP_DATA/agent-browser/profile/`) into the restore key once, then
  renames it to `profile-imported`.

Saved state lives under `~/.agent-browser/sessions/`. **Security:** it is as
sensitive as a password manager. Protect host disk, Tailscale access, and Jean
token auth.

## Commands (Phase 1 — implemented)

| Command | Purpose |
| --- | --- |
| `get_agent_browser_status` | Binary detection (Jean-managed or PATH), version, snippets |
| `install_agent_browser` | npm install into `$app_data/agent-browser-cli`, then `agent-browser install` (Chromium) |
| `install_agent_browser_mcp` | Upsert MCP entry into Claude/Codex/OpenCode/Cursor/Grok/Kimi configs; auto-enable in Jean prefs |

Registered in `http_server/dispatch.rs` (native + web access).

MCP entry shape (Claude):

```json
{
  "mcpServers": {
    "agent-browser": {
      "type": "stdio",
      "command": "agent-browser",
      "args": ["mcp"],
      "env": {
        "AGENT_BROWSER_RESTORE": "jean",
        "AGENT_BROWSER_IDLE_TIMEOUT_MS": "900000"
      }
    }
  }
}
```

## UI

Settings → **MCP Servers** → **Agent Browser** (`AgentBrowserSection.tsx`):

- Status (installed / missing binary; Jean-managed vs PATH)
- **Install agent-browser** (npm into app data + Chromium download + MCP setup for installed backends)
- Copy Claude / Codex snippets
- Operator fallback: `npm install -g agent-browser && agent-browser install`

## Manual-login flows

### A. Display available

1. Install agent-browser, Chromium, and MCP from Settings.
2. Log in once in a headed browser that uses the shared restore key:
   `AGENT_BROWSER_RESTORE=jean agent-browser --session jean-login --headed open <url>`,
   log in (2FA, CAPTCHA), then `agent-browser --session jean-login close` to save.
3. New agent sessions load that login (including headless).

### B. Headless VPS

1. Chromium under **Xvfb** (+ optional noVNC) for first login.
2. Same restore key (`jean`) for subsequent agent runs.
3. Future Phase 3: noVNC inside Jean Web Access.

### C. State handoff

`agent-browser state save/load` or cookie import if no remote display.

## Roadmap

### Phase 1 (this PR) — done

- [x] App-data profile dir
- [x] Status / ensure profile / install MCP commands
- [x] Settings UI section
- [x] Auto-enable MCP keys in preferences on install
- [x] Unit tests for config writers / snippets

### Phase 2

- [ ] Managed Chromium lifecycle owned by Jean
- [ ] Session cancel cleans browser daemon children
- [ ] Optional Jean-managed install of agent-browser binary

### Phase 3

- [ ] Xvfb + noVNC remote view in Web Access
- [ ] Origin allowlist + action audit log

## Operator quick start

**Preferred:** Settings → **MCP Servers** → **Agent Browser** → **Install agent-browser**
(requires `npm` on the server PATH; installs under app data and runs Chromium setup).

Manual fallback:

```bash
npm install -g agent-browser
agent-browser install          # Chrome for Testing
# Linux headless hosts:
agent-browser install --with-deps
```

Then use the Claude or Codex snippet only if you need to configure a backend manually.

In chat (after first manual login):

```text
Open https://example.com/account and describe what you see.
If you hit a login wall, stop so I can sign in in the agent browser.
```

## Related

- `docs/developer/server-architecture.md`
- `docs/developer/embedded-browser-grab.md` (desktop-only)
- `docs/headless-server.md`
- https://agent-browser.dev
- https://code.claude.com/docs/en/chrome (desktop Claude Chrome path)
