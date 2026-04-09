# Terminal Status Indicator

Based on upstream PR #285 (`feat(terminal): live process & port detection in sidebar`).

## What

Show a play icon next to each worktree name when a terminal has a running process. Hovering shows the command and detected TCP ports (e.g. `bun run dev (:3000)`). If the process crashes (non-zero exit), the icon turns red with "(crashed)". Clicking the icon opens the terminal.

## Why

Before, there was no way to know at a glance if a dev server was running in a worktree's terminal, which port it was on, or if it had crashed. The only indicator was a generic spinner that didn't distinguish running vs. crashed and showed no port info.

## Tweaks on top of upstream PR

1. **Icon position**: Moved from the left side (before the title) to directly after the worktree name text. Keeps it close to the name but out of the leading indicator area.
2. **Clickable**: Clicking the play icon opens the terminal for that worktree. In both canvas view and sidebar, this opens the session chat modal with the terminal drawer visible. Click uses `stopPropagation` to avoid triggering the parent row's click handler.

## Upstream scope (PR #285)

- **Rust**: New `get_terminal_listening_ports` command that uses `lsof` + process tree walking (`ps -eo pid=,ppid=`) to find TCP LISTEN ports belonging to terminal child processes. Unix-only; returns empty on Windows and web access.
- **Terminal store**: Added `failedTerminals: Set<string>` tracking terminals that exited with non-zero code. All mutations guarded against no-op updates.
- **Terminal exit handling**: Reworked to distinguish clean exits (code 0, SIGINT, SIGTERM) from crashes. Crashes set `failedTerminals`; clean exits auto-close the terminal tab.
- **Hook + component**: `useWorktreeTerminalStatus` hook reads running/failed state and polls for listening ports (every 5s, only when active). `TerminalStatusIndicator` renders the play icon with tooltip.
- **Port polling**: `useTerminalListeningPorts` TanStack Query hook, enabled only when terminals are running.

## Dependencies

- No dependency on other customizations.
- Depends on upstream terminal store having `runningTerminals` set (already present).
