# UI Tweaks

## What
- Always use the narrow/compact indentation for sidebar worktree items, regardless of sidebar width. The default indentation feels too generous.
- Remove background "pill" styling from all sidebar badges (issues, PRs, workflow runs, security alerts, push/pull commits). Keep the colored text and icons, just drop the rounded background, padding, and hover-background. The pills take up too much visual space in the sidebar.
- Remove aggressive JS hard-truncation on collapsed tool call rows, letting CSS handle responsive truncation instead. The JS truncation cuts text at 50-60 chars regardless of available width, wasting space on wide windows.

## Why
- **Compact indentation**: The wide padding mode wastes horizontal space, causing worktree names and badges to truncate unnecessarily.
- **Badge de-pilling**: With pill backgrounds removed, badges become lightweight colored text that blends into the sidebar row without dominating it. The color and icon are already enough to communicate meaning.

## Scope

### Compact sidebar indentation
- `WorktreeList.tsx`: Reduce left margin from `ml-4` to `ml-2`
- `WorktreeItem.tsx`: Force narrow padding (`pl-3`) instead of conditional `pl-4`/`pl-7`; force narrow session list margin (`ml-4`) instead of conditional `ml-6`/`ml-9`
- `WorktreeItem.tsx`: Reduce worktree row vertical padding from `py-1.5` to `py-1` so worktree rows are closer in height to session rows

### Badge de-pilling
- Strip `rounded bg-COLOR/10 px-1.5 py-0.5` and `hover:bg-COLOR/20` from all sidebar badge buttons
- Replace with `transition-opacity hover:opacity-70`
- Affected components: `NewIssuesBadge`, `OpenPRsBadge`, `FailedRunsBadge`, `SecurityAlertsBadge`, `WorktreeItem` (push/pull), `ProjectTreeItem` (base branch push/pull), `git-status-badges` (shared component)
- Bump project-level badge container gap from `gap-1` to `gap-2` to compensate for removed padding

### Tool call truncation removal
- In `ToolCallInline.tsx`, remove JS `substring()` truncation — CSS `truncate` on the `<code>` element adapts to available width
- **Bash commands**: Remove `command.substring(0, 50)`, pass raw `command` as `detail`
- **SpawnAgent prompts**: Remove `prompt.substring(0, 60)`, pass raw `prompt` as `detail`
- **SubToolItem / SubThinkingItem**: Add `min-w-0` to their `CollapsibleTrigger` so flex children can shrink and CSS truncation takes effect

