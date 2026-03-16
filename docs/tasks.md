# Task Management

## Overview

- **Uncompleted tasks** are in tasks-todo/
  - Named task-NUMBER-name.md where NUMBER indicates priority order
  - The lowest number is the current task
  - If NUMBER is x, the task has not been prioritized yet
- **Completed tasks** are in tasks-done/
  - Named task-YYYY-MM-DD-name.md with completion date

## Completing Tasks

When you finish a task, use the completion script.

Usage: bun run task:complete TASK_NAME_OR_NUMBER

Examples:
bun run task:complete frontend-performance
bun run task:complete 2
bun run task:complete awesome-feature

The script will:

1. Find the matching task in tasks-todo/
2. Strip the task-NUMBER- prefix
3. Add todays date prefix: task-YYYY-MM-DD-
4. Move it to tasks-done/

Example transformation:
tasks-todo/task-2-frontend-performance-optimization.md
becomes
tasks-done/task-2025-11-01-frontend-performance-optimization.md

### Renaming Existing Completed Tasks

If you have existing completed tasks without dates, rename them using their last modified date:

Usage: bun run task:rename-done
