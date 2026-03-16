---
allowed-tools: [Read, Bash, Glob, TodoWrite, Edit]
description: 'Check work for adherance with architecture and run checks'
---

# /check - Check Work

## Purpose

Check work for adherance with architecture and run checks

## Usage

```
/check
```

## Execution

1. Check all work in this session for adherance with `docs/developer/architecture-guide.md`.
2. Remove any unnececarry comments or `console.logs` we've introduced and clean up any "leftovers" from approaches we tried but didn't work.
3. Run `bun run check:all` and fix any errors.
