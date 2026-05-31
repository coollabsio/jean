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

Run Jean without the desktop window and expose the web UI over HTTP:

```bash
jean --headless --host 127.0.0.1 --port 3456
```

`--host` accepts `localhost` or an IP address. Passing a specific address such
as your Tailscale IP binds Jean only to that interface.

## Roadmap

- Enhance remote web access

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


---

## FAQ

### What is Jean?

Jean is a desktop AI assistant for managing multiple projects, worktrees, and chat sessions with Claude CLI, Codex CLI, Cursor CLI, and OpenCode. It's built with Tauri v2, React 19, Rust, TypeScript, and provides a powerful interface for AI-assisted development.

### What AI CLI tools does Jean support?

Jean supports the following AI CLI tools:

| CLI | Features |
|-----|----------|
| **Claude CLI** | Anthropic Claude models (Opus 4.5/4.6, Sonnet, Haiku), MCP server support, thinking/effort levels |
| **Codex CLI** | OpenAI models, multi-agent collaboration, file picker & image attachments |
| **Cursor CLI** | VS Code-style AI coding, custom system prompts, custom CLI profiles |
| **OpenCode** | Open-source alternative, model selection, notification sounds |

### What are the key features?

| Feature | Description |
|---------|-------------|
| **Project & Worktree Management** | Multi-project support, linked projects, git worktree automation |
| **Session Management** | Multiple sessions per worktree, execution modes (Plan/Build/Yolo), session recap/digest |
| **AI Chat** | Model selection, thinking/effort levels, MCP server support, file picker & image attachments |
| **Magic Commands** | Investigate issues/PRs/workflows, code review, AI commit messages, PR content generation |
| **GitHub Integration** | Dashboard with Issues, PRs, Security Alerts, Dependabot investigation |
| **Linear Integration** | Issue investigation, context loading, per-project API key and team configuration |
| **Developer Tools** | Multi-dock terminal, command palette, diff viewer, file tree, debug panel |
| **Remote Access** | Built-in HTTP server with WebSocket support, token-based auth, web browser access |

### How do I install Jean?

**Homebrew (macOS):**
```bash
brew tap coollabsio/jean
brew install --cask jean
```

**Download from GitHub Releases:**
Visit [jean.build](https://jean.build) or the [GitHub Releases](https://github.com/coollabsio/jean/releases) page.

### What are the requirements?

- macOS (tested), Windows (not fully tested), Linux (community tested)
- Claude CLI, Codex CLI, Cursor CLI, or OpenCode installation
- Node.js and Rust for building from source

### Is there vendor lock-in?

No. Everything runs locally on your machine with your own Claude CLI, Codex CLI, Cursor CLI, or OpenCode installation. No data is sent to any third-party server.

### What themes are available?

Jean supports themes: light, dark, and system. It also supports custom fonts, customizable AI prompts, configurable keybindings, and mobile swipe gestures.

### How can I contribute?

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup and guidelines.

### Where can I get help?

- **Website**: [jean.build](https://jean.build)
- **GitHub Issues**: [coollabsio/jean/issues](https://github.com/coollabsio/jean/issues)
- **GitHub Releases**: [coollabsio/jean/releases](https://github.com/coollabsio/jean/releases)

### What license does Jean use?

Jean is open source. Check the [LICENSE](LICENSE) file for details.

