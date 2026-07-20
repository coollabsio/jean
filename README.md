<div align="center">

# Jean

A desktop AI assistant for managing multiple projects, worktrees, and chat sessions with Claude CLI, Codex CLI, Cursor CLI, and OpenCode.

Tauri v2 · React 19 · Rust · TypeScript · Tailwind CSS v4 · shadcn/ui v4 · Zustand v5 · TanStack Query · CodeMirror 6 · xterm.js

</div>

## About the Project

Jean is an opinionated native desktop app built with Tauri that gives you a powerful interface for working with Claude CLI, Codex CLI, Cursor CLI, and OpenCode across multiple projects. It has strong opinions about how AI-assisted development should work — managing git worktrees, chat sessions, terminals, GitHub and Linear integrations in one cohesive workflow.

No vendor lock-in. Everything runs locally on your machine with your own Claude CLI, Codex CLI, Cursor CLI, or OpenCode installation.

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

- **Project & Worktree Management** — Multi-project support, linked projects for cross-project context, git worktree automation (create, archive, restore, delete), custom project avatars
- **Session Management** — Multiple sessions per worktree, execution modes (Plan, Build, Yolo) with plan approval flows, session recap/digest, saved contexts with AI summarization, archiving with retention settings, recovery, auto-naming, canvas views
- **AI Chat (Claude CLI, Codex CLI, Cursor CLI, OpenCode)** — Model selection (Opus 4.5, Opus 4.6, Opus 4.6 1M, Sonnet 4.6, Haiku), thinking/effort levels with per-mode overrides, MCP server support, Codex multi-agent collaboration, file picker & image attachments, chat search, notification sounds, custom system prompts, custom CLI profiles
- **Magic Commands** — Investigate issues/PRs/workflows, code review with finding tracking, AI commit messages, PR content generation, merge conflict resolution, release notes generation, customizable per-prompt model/backend/effort selection
- **GitHub Integration** — Dashboard with Issues, PRs, Security Alerts, and Advisories tabs, Dependabot investigation, checkout PRs as worktrees, auto-archive on PR merge, workflow investigation
- **Linear Integration** — Issue investigation, context loading, per-project API key and team configuration
- **Developer Tools** — Multi-dock terminal (floating, left, right, bottom), command palette, open in editor (Zed, VS Code, Cursor, Xcode, IntelliJ), git operations (status, stash, revert, fetch/merge with conflict detection), diff viewer (unified & side-by-side), file tree with preview, debug panel with token usage tracking
- **Remote Access** — Built-in HTTP server with WebSocket support, token-based auth, web browser access
- **Customization** — Themes (light/dark/system), custom fonts, customizable AI prompts, configurable keybindings, mobile swipe gestures

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

## Headless Web Access

Run Jean as a standalone Linux server (`jean-server`) with browser Web Access —
no desktop window, GTK, or WebView required. Linux **amd64** and **arm64** only
(glibc + OpenSSL 3; Ubuntu 22.04+ / Debian 12+ recommended).

### Install (release binary + systemd)

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

# Tailscale-only bind (auto-detect Tailscale IPv4)
sudo ./scripts/install-jean-server.sh --host tailscale -y

# Current user only (user systemd unit)
./scripts/install-jean-server.sh --user-install --host 127.0.0.1 -y
```

### Run manually

```bash
jean-server --host 127.0.0.1 --port 3456
# or with an explicit token:
jean-server --host 127.0.0.1 --port 3456 --token "$JEAN_TOKEN"
```

`--host` accepts `localhost` or an IP address (for example a Tailscale IP) to
bind only that interface. Docker images are also published as
`ghcr.io/coollabsio/jean-server`.

See [docs/headless-server.md](docs/headless-server.md) for systemd details,
reverse proxies, updates, and security notes.

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
