<div align="center">

# Jean

A desktop AI assistant for managing multiple projects, worktrees, and chat sessions with Claude CLI, Codex CLI, and OpenCode.

Tauri v2 · React 19 · Rust · TypeScript · Tailwind CSS v4 · shadcn/ui v4 · Zustand v5 · TanStack Query · CodeMirror 6 · xterm.js

</div>

## About the Project

Jean is an opinionated native desktop app built with Tauri that gives you a powerful interface for working with Claude CLI, Codex CLI, and OpenCode across multiple projects. It has strong opinions about how AI-assisted development should work — managing git worktrees, chat sessions, terminals, and GitHub integrations in one cohesive workflow.

No vendor lock-in. Everything runs locally on your machine with your own Claude CLI, Codex CLI, or OpenCode installation.

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

- **Project & Worktree Management** — Multi-project support, git worktree automation (create, archive, restore, delete), custom project avatars
- **Session Management** — Multiple sessions per worktree, execution modes (Plan, Build, Yolo), archiving, recovery, auto-naming, canvas views
- **AI Chat (Claude CLI, Codex CLI, OpenCode)** — Model selection (Opus, Sonnet, Haiku), thinking/effort levels, MCP server support, file mentions, image support, custom system prompts
- **Magic Commands** — Investigate issues/PRs/workflows, code review with finding tracking, AI commit messages, PR content generation, merge conflict resolution, release notes
- **GitHub Integration** — Issue & PR investigation, checkout PRs as worktrees, auto-archive on PR merge, workflow investigation
- **Developer Tools** — Integrated terminal, open in editor (Zed, VS Code, Cursor, Xcode), git status, diff viewer (unified & side-by-side), file tree with preview
- **Remote Access** — Built-in HTTP server with WebSocket support, token-based auth, web browser access
- **Customization** — Themes (light/dark/system), custom fonts, customizable AI prompts, configurable keybindings

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
