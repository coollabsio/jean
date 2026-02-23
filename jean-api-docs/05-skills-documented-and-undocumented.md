# Skills: Documented And Undocumented

Jean exposes Claude skill discovery over WebSocket via:
- `list_claude_skills`
- `list_claude_commands`

## Documented behavior from code

Implementation: `src-tauri/src/projects/commands.rs`

`list_claude_skills`:
- Scans `~/.claude/skills`
- Accepts directories containing `SKILL.md`
- Returns `name`, `path`, optional `description`
- Description is parsed only from first line if it starts with `# `

`list_claude_commands`:
- Scans `~/.claude/commands`
- Accepts top-level `*.md`
- Returns `name`, `path`, optional `description`

## Skills currently discoverable on this machine

From `~/.claude/skills/*/SKILL.md`:
- `agent-messaging`
- `ai-maestro-agents-management`
- `docs-search`
- `graph-query`
- `memory-search`
- `planning`

From `~/.claude/commands/*.md`:
- none currently found

## Undocumented/hidden layer

There are Codex system skills in this environment:
- `~/.codex/skills/.system/skill-creator/SKILL.md`
- `~/.codex/skills/.system/skill-installer/SKILL.md`

These are not returned by Jean's `list_claude_skills` because that command is Claude-path-specific (`~/.claude/...`) and non-recursive by design.

## Practical implication for MCP server builders

If you need a complete “skills universe”, you should merge:
- Jean API results (`list_claude_skills`, `list_claude_commands`)
- Additional local scans you define (for example `.codex/skills`), with explicit trust rules.
