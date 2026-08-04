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
| Login persistence | Jean-owned profile dir + `AGENT_BROWSER_PROFILE` |
| Scope | **Browser use** (web only), not full desktop computer use |

Jean does not reimplement CDP. Jean owns profile path, Settings UI, and
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
│       │ install MCP / profile                             │
│       ▼                                                   │
│  Claude/Codex/… session                                   │
│       │ MCP tools (agent-browser)                         │
│       ▼                                                   │
│  agent-browser daemon ──► Chromium + Jean profile         │
│       cookies / localStorage survive restarts             │
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

## Profile location

```text
$JEAN_APP_DATA/agent-browser/profile/     # Chromium user-data-dir
```

Env passed into MCP:

```text
AGENT_BROWSER_PROFILE=<that path>
```

**Security:** the profile is as sensitive as a password manager. Protect host
disk, Tailscale access, and Jean token auth.

## Commands (Phase 1 — implemented)

| Command | Purpose |
| --- | --- |
| `get_agent_browser_status` | Binary detection (Jean-managed or PATH), version, profile path/exists, snippets |
| `ensure_agent_browser_profile` | Create profile directory |
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
        "AGENT_BROWSER_PROFILE": "/path/to/app-data/agent-browser/profile"
      }
    }
  }
}
```

## UI

Settings → **MCP Servers** → **Agent Browser** (`AgentBrowserSection.tsx`):

- Status (installed / missing binary; Jean-managed vs PATH)
- Profile path
- **Install agent-browser** (npm into app data + Chromium download)
- Create profile
- Install MCP into installed backends
- Copy Claude / Codex snippets
- Operator fallback: `npm install -g agent-browser && agent-browser install`

## Manual-login flows

### A. Display available

1. Install agent-browser + Chromium.
2. Install MCP from Settings.
3. Headed first run: user logs in (2FA, CAPTCHA).
4. Later turns reuse the profile (including headless).

### B. Headless VPS

1. Chromium under **Xvfb** (+ optional noVNC) for first login.
2. Same profile path for subsequent agent runs.
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

Then: **Install MCP into backends**.

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
