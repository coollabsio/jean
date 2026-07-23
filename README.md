<div align="center">

# Jean

A desktop AI assistant for managing multiple projects, worktrees, and chat sessions with Claude CLI, Codex CLI, Cursor CLI, OpenCode, PI, Command Code, Grok, and Kimi Code.

Tauri v2 · React 19 · Rust · TypeScript · Tailwind CSS v4 · shadcn/ui v4 · Zustand v5 · TanStack Query · CodeMirror 6 · xterm.js

</div>

## About the Project

Jean is an opinionated native desktop app built with Tauri that gives you a powerful interface for working with Claude CLI, Codex CLI, Cursor CLI, OpenCode, PI, Command Code, Grok, and Kimi Code across multiple projects. It has strong opinions about how AI-assisted development should work - managing git worktrees, chat sessions, terminals, GitHub and Linear integrations in one cohesive workflow.

No vendor lock-in. Everything runs locally on your machine with your own CLI installations.

For more information, take a look at [jean.build](https://jean.build).

## Screenshots

<table>
<tr>
<td><img src="screenshots/SCR-20260304-krym.png" width="400" alt="Screenshot 1" /></td>
<td><img src="screenshots/SCR-20260304-ksgh.png" width="400" alt="Screenshot 2" /></td>
</tr>
<tr>
<td><img src="screenshots/SCR-20260304-ksjn.png" width="400" alt="Screenshot 3" /></td>
<td><img src="screenshots/SCR-20260304-ksnq.png" width="400" alt="Screenshot 4" /></td>
</tr>
<tr>
<td><img src="screenshots/SCR-20260304-kstl.png" width="400" alt="Screenshot 5" /></td>
<td><img src="screenshots/SCR-20260304-ktab.png" width="400" alt="Screenshot 6" /></td>
</tr>
<tr>
<td><img src="screenshots/SCR-20260304-ktwr.png" width="400" alt="Screenshot 7" /></td>
<td><img src="screenshots/SCR-20260304-kuhk.png" width="400" alt="Screenshot 8" /></td>
</tr>
</table>

## Features

- **Project & Worktree Management** - Multi-project support, linked projects for cross-project context, git worktree automation (create, archive, restore, delete), custom project avatars
- **Session Management** - Multiple sessions per worktree, execution modes (Plan, Build, Yolo) with plan approval flows, session recap/digest, saved contexts with AI summarization, archiving with retention settings, recovery, auto-naming, canvas views
- **AI Chat (Claude, Codex, Cursor, OpenCode, PI, Command Code, Grok, Kimi)** - Model selection and thinking/effort levels with per-mode overrides, MCP server support, multi-agent collaboration, file picker & image attachments, chat search, notification sounds, custom system prompts, custom CLI profiles
- **Magic Commands** - Investigate issues/PRs/workflows, code review with finding tracking, AI commit messages, PR content generation, merge conflict resolution, release notes generation, customizable per-prompt model/backend/effort selection
- **GitHub Integration** - Dashboard with Issues, PRs, Security Alerts, and Advisories tabs, Dependabot investigation, checkout PRs as worktrees, auto-archive on PR merge, workflow investigation
- **Linear Integration** - Issue investigation, context loading, per-project API key and team configuration
- **Developer Tools** - Multi-dock terminal (floating, left, right, bottom), command palette, open in editor (Zed, VS Code, VSCodium, Cursor, Xcode, IntelliJ), git operations (status, stash, revert, fetch/merge with conflict detection), diff viewer (unified & side-by-side), file tree with preview, debug panel with token usage tracking
- **Web Access** - Every Jean instance (desktop or headless server) can expose the full UI over HTTP/WebSocket with token auth so you can use it from a browser on your network
- **Customization** - Themes (light/dark/system), custom fonts, customizable AI prompts, configurable keybindings, mobile swipe gestures

## Installation

Download the latest version from the [GitHub Releases](https://github.com/coollabsio/jean/releases) page or visit [jean.build](https://jean.build).

### Homebrew (macOS)

```bash
brew tap coollabsio/jean
brew install --cask jean
```

### Building from Source

Prerequisites:

- [Node.js](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/tools/install)
- **Windows only**: In the Visual Studio Installer, ensure the **"Desktop development with C++"** workload is selected, which includes:
  - MSVC C++ build tools
  - Windows SDK (provides `kernel32.lib` and other system libraries required by Rust)

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup and guidelines.

## Platform Support

- **macOS**: Tested
- **Windows**: Not fully tested
- **Linux**: Community tested (Arch Linux + Hyprland/Wayland)

## Web Access

Every Jean instance can run **Web Access**: an embedded HTTP + WebSocket server
that serves the same UI in a browser. That applies to both:

| Mode | How you get Web Access |
| --- | --- |
| **Native desktop** (macOS / Windows / Linux) | Settings → **Web Access** - enable the HTTP server, set port/bind address, copy the token URL |
| **Headless server** (`jean-server`) | Always on - the process *is* the Web Access endpoint |

Use it to open Jean from another machine on your LAN, a phone/tablet browser,
or a remote host. Token authentication is on by default; keep it enabled for
any non-localhost bind.

### Network access (recommended: Tailscale)

Web Access binds a normal TCP port (default **3456**). For access beyond the
local machine, prefer a private mesh VPN rather than exposing the port to the
public internet:

- **[Tailscale](https://tailscale.com/)** (recommended) - bind Jean to the
  Tailscale IP (or use the installer's `--host tailscale` preset) and open the
  URL from any device on your tailnet
- Other options: WireGuard, ZeroTier, SSH tunnel, or a reverse proxy with TLS
  in front of `127.0.0.1`

Keep token auth enabled, use a long random token
(`openssl rand -base64 32`), and avoid binding `0.0.0.0` on untrusted networks
unless you also terminate TLS and restrict who can reach the port.

### Desktop app

1. Open **Settings → Web Access**
2. Enable **HTTP server** (optionally turn on **Auto-start**)
3. Set **Port** and **Bind address** (`127.0.0.1` for local only, LAN IP,
   `0.0.0.0`, or your Tailscale IP)
4. Open the shown URL (includes `?token=...`) in a browser, or share it with
   devices that can reach that host

The native app can also connect to a remote Jean Web Access server (title bar
server icon → **Add remote**) while keeping the desktop shell.

### Headless server (`jean-server`)

Run Jean as a standalone Linux server with browser Web Access - no desktop
window, GTK, or WebView required. Linux **amd64** and **arm64** only
(glibc + OpenSSL 3; Ubuntu 22.04+ / Debian 12+ recommended).

#### Install (release binary + systemd)

Interactive install (prompts for bind interface + port when a TTY is available):

```bash
curl -fsSL https://raw.githubusercontent.com/coollabsio/jean/main/scripts/install-jean-server.sh | sudo bash
```

Non-interactive (defaults to `127.0.0.1:3456`, or pass `--host` / `--port`):

```bash
curl -fsSL https://raw.githubusercontent.com/coollabsio/jean/main/scripts/install-jean-server.sh | sudo bash -s -- -y
```

Or from a clone:

```bash
sudo ./scripts/install-jean-server.sh --host 127.0.0.1 --port 3456 -y
```

The installer downloads the latest release, installs the binary, writes an env
file (host/port/token), and registers a systemd service. Re-run to upgrade;
existing tokens are preserved unless you pass `--token`.

Common options:

```bash
# Public bind with an explicit token
sudo ./scripts/install-jean-server.sh \
  --host 0.0.0.0 \
  --port 3456 \
  --token "$(openssl rand -base64 32)" \
  -y

# Tailscale-only bind (auto-detect Tailscale IPv4) - recommended for remote use
sudo ./scripts/install-jean-server.sh --host tailscale -y

# Current user only (user systemd unit)
./scripts/install-jean-server.sh --user-install --host 127.0.0.1 -y
```

#### Run manually

```bash
jean-server --host 127.0.0.1 --port 3456
# or with an explicit token:
jean-server --host 127.0.0.1 --port 3456 --token "$JEAN_TOKEN"
```

`--host` accepts `localhost`, presets (`tailscale`, `lan`, `0.0.0.0`, …), or
any IP/hostname to bind only that interface. Docker images are also published
as `ghcr.io/coollabsio/jean-server`.

See [docs/headless-server.md](docs/headless-server.md) for systemd details,
reverse proxies, updates, native remote connections (including Install via SSH
from user + IP), and security notes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Core Maintainer

|                                                                                                                                                                            Andras Bacsai                                                                                                                                                                             |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
|                                                                                                                                         <img src="https://github.com/andrasbacsai.png" width="200px" alt="Andras Bacsai" />                                                                                                                                          |
| <a href="https://github.com/andrasbacsai"><img src="https://api.iconify.design/devicon:github.svg" width="25px"></a> <a href="https://x.com/heyandras"><img src="https://api.iconify.design/devicon:twitter.svg" width="25px"></a> <a href="https://bsky.app/profile/heyandras.dev"><img src="https://api.iconify.design/simple-icons:bluesky.svg" width="25px"></a> |

## Philosophy

Learn more about our approach: [Philosophy](https://coollabs.io/philosophy/)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=coollabsio/jean&type=Date)](https://star-history.com/#coollabsio/jean&Date)
