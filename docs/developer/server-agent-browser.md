# Server Agent Browser (manual login + AI control)

## Goal

On **jean-server** (and Web Access without a desktop display), let the user
**log into accounts manually once**, then let coding agents **drive the same
browser** for authenticated workflows (Gmail, admin panels, SaaS apps, etc.).

This is **not** Jean's desktop embedded browser (Tauri child Webviews + React
Grab). That path is desktop-only and has no server equivalent.

## What already exists

| Capability | Where | Server-friendly? |
| --- | --- | --- |
| Embedded Browser panel (tabs, grab DOM) | `src-tauri/src/browser/*`, React `src/components/browser/*` | **No** — Tauri Webview |
| Claude Chrome integration (`--chrome`) | `chrome_enabled` prefs → Claude CLI | **Only if** Chrome + [Claude in Chrome](https://code.claude.com/docs/en/chrome) extension run on a machine with a real display and Anthropic plan login (not API-key-only) |
| MCP discovery / enable | Settings → MCP, project/session toggles | **Yes** — any MCP the host can spawn |
| Playwright / chrome-devtools MCP | User-installed MCP servers | **Yes** — best fit for jean-server today |

## Recommended architecture (jean-server)

```text
┌──────────────────── jean-server host ─────────────────────┐
│                                                           │
│  User (browser on phone/laptop)                           │
│       │ HTTPS / Tailscale                                 │
│       ▼                                                   │
│  Jean Web Access UI  ── optional ──► noVNC / remote view  │
│       │                              of agent Chromium    │
│       ▼                                      │            │
│  Claude/Codex/… session                      │            │
│       │ MCP tools (click, type, navigate)    │            │
│       ▼                                      ▼            │
│  Playwright MCP  ──CDP / user-data-dir──► Chromium        │
│       persistent profile under Jean app-data              │
│       (cookies, localStorage, logins survive restarts)    │
└───────────────────────────────────────────────────────────┘
```

### Why not re-use the embedded browser?

- jean-server intentionally has **no Tauri, WebView, GTK, or display server**.
- Child Webviews cannot run in the headless binary.
- Server AI processes need a **local automation surface** (CDP / Playwright),
  not a React-hosted iframe of arbitrary third-party sites (cookie isolation,
  cross-origin, and security constraints).

### Why Playwright MCP (or chrome-devtools-mcp)?

- Works for **all backends** Jean already wires MCP into (Claude, Codex,
  OpenCode, Cursor, Grok, Kimi), not Claude-only.
- **Persistent profile** is first-class: login once, reuse forever.
- Structured accessibility snapshots (no vision model required).
- Optional headless for pure automation after login; headed for first login.

Claude `--chrome` remains great for **desktop** Jean where the user already
has Chrome + extension. Prefer Playwright MCP on **servers**.

## Manual-login flows

### A. Display available (local machine, RDP, cloud desktop)

1. Install Playwright MCP with a Jean-owned profile directory.
2. Run **headed** (default): browser window opens.
3. User logs into sites manually (2FA, CAPTCHA, passkeys).
4. Leave profile on disk; later sessions (even headless) reuse cookies.

### B. True headless VPS (no monitor) — recommended remote UX

1. Run Chromium under **Xvfb** (virtual display).
2. Export the display via **x11vnc + noVNC** (or similar).
3. Jean Web Access (future) embeds noVNC so the user logs in from any browser
   on the Tailscale network.
4. Agent attaches via Playwright MCP / CDP to the **same** Chromium + profile.

Until Jean hosts noVNC natively, operators can run the display stack beside
jean-server and point Playwright MCP at the profile or CDP port.

### C. Storage-state handoff (no remote desktop)

1. User logs in on a trusted machine with Playwright `storageState`.
2. Copy the JSON into the server profile / pass `--storage-state`.
3. Weaker than a full profile (some sites re-auth aggressively) but avoids VNC.

## Profile location (proposed)

```text
$JEAN_APP_DATA/agent-browser/profile/     # Chromium user-data-dir
$JEAN_APP_DATA/agent-browser/mcp.json     # optional Jean-generated MCP snippet
```

Single shared profile by default (one set of accounts). Future: per-project
profiles under `agent-browser/profiles/<project-id>/`.

**Security:** this profile is as sensitive as a password manager. Protect host
disk, Tailscale access, and Jean token auth. Do not commit profile dirs.
Treat agent actions on logged-in sites as full account access.

## MCP config sketch (works today without Jean product code)

Claude (`~/.claude.json`):

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--user-data-dir",
        "/var/lib/jean/agent-browser/profile"
      ]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--user-data-dir", "/var/lib/jean/agent-browser/profile"]
enabled = true
```

Headless after login:

```text
... "--user-data-dir", "...", "--headless"
```

Standalone HTTP MCP (useful when Jean sessions share one long-lived browser):

```bash
npx -y @playwright/mcp@latest \
  --user-data-dir /var/lib/jean/agent-browser/profile \
  --port 8931
```

Then point backends at `http://127.0.0.1:8931/mcp`.

Prerequisites on the host:

- Node.js 20+
- `npx` can download `@playwright/mcp`
- Playwright browsers installed (`npx playwright install chromium` as needed)
- For headed first login on a server: `Xvfb` / desktop / noVNC stack

After MCP is enabled in Jean (Settings → MCP → enable `playwright` for the
backend/project/session), ask the agent:

```text
Open https://example.com/account, describe what you see.
If I'm not logged in, stop and tell me so I can log in manually.
```

## Product roadmap (Jean-native)

### Phase 0 — document + operator setup (this doc)

No Jean binary changes. Operators install Playwright MCP + persistent profile.

### Phase 1 — Jean-managed profile + one-click MCP install

- Commands: `get_agent_browser_status`, `install_agent_browser_mcp`,
  `reset_agent_browser_profile` (destructive, confirm).
- Create `$app_data/agent-browser/profile`.
- Reuse the safe config writers in `jean_mcp_config.rs` to upsert a
  `playwright` (or `jean-browser`) MCP entry for selected backends.
- Settings UI: Integrations / Experimental section with status + install.
- Prefs: `agent_browser_enabled`, `agent_browser_headless`, profile path override.

### Phase 2 — Managed Chromium lifecycle

- Start/stop Chromium (or Playwright-managed browser) with fixed CDP port.
- Health checks; ensure only one owner of the user-data-dir lock.
- Prefer attaching Playwright MCP with `--cdp-endpoint` / equivalent so Jean
  owns process lifecycle and MCP is a thin client.

### Phase 3 — Remote view in Web Access (manual login UX)

- Bundle or vendor noVNC static assets; serve under `/agent-browser/vnc/`.
- Spawn Xvfb + Chromium + websockify when `agent_browser_remote_view` is on.
- Token-gated iframe in Jean UI: “Open agent browser” for login / watch.
- Clear “AI is controlling this browser” indicator; optional pause/takeover.

### Phase 4 — First-class agent tools (optional)

- Jean-owned MCP tools (`browser_navigate`, `browser_snapshot`, …) so backends
  without flexible MCP still work, and permissions can be Jean-scoped.
- Session-level allowlist of origins; block navigation outside allowlist in
  plan mode.
- Audit log of browser actions in run JSONL.

## Non-goals

- Replacing the desktop embedded browser panel for local UI debugging / grab.
- Giving the agent passwords; manual login remains the auth path.
- Running untrusted page JS inside the Jean shell origin.
- Multi-user browser isolation on one jean-server (start with single-tenant).

## Backend notes

- **Claude:** can use either Playwright MCP or `--chrome` (desktop). Prefer MCP
  on server; keep `chrome_enabled` for desktop users with the extension.
- **Codex / Grok / OpenCode / Cursor / Kimi:** MCP only for browser automation.
- Kill lingering MCP browser children on session cancel (Codex already notes
  chrome-devtools-mcp orphans — apply the same hygiene).

## Testing strategy

- Unit: profile path resolution, MCP config patch idempotency, headless flag.
- Integration (optional CI): start Playwright MCP against a local static page
  with storage state; assert navigate + snapshot tools respond.
- Manual: login to a test site headed → restart jean-server → headless session
  still authenticated.

## Related docs

- `docs/developer/server-architecture.md` — no WebView on server
- `docs/developer/embedded-browser-grab.md` — desktop-only grab bridge
- `docs/headless-server.md` — jean-server ops
- User: Web Access / headless (jean-docs)
- Playwright MCP: https://playwright.dev/docs/getting-started-mcp
- Claude Chrome: https://code.claude.com/docs/en/chrome
