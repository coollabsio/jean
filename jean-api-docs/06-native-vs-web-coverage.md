# Native vs Web Coverage

This file clarifies what works over WebSocket vs native Tauri invoke.

## Browser no-op commands in WS dispatch

These are present in WebSocket dispatch but intentionally return null/empty/false in browser mode.

Worktree/app launching:
- `open_worktree_in_finder`
- `open_project_worktrees_folder`
- `open_worktree_in_terminal`
- `open_worktree_in_editor`
- `open_file_in_default_app`

Terminal operations:
- `start_terminal`
- `terminal_write`
- `terminal_resize`
- `stop_terminal`
- `get_active_terminals` (empty array)
- `has_active_terminal` (false)
- `get_run_script`

Native drag-drop:
- `save_dropped_image`

## WS-only caveat for server lifecycle

- `start_http_server` (over WS) returns current status and does not "re-start" from that same connection context.
- `stop_http_server` (over WS) returns an error by design:
  - `Cannot stop HTTP server from a WebSocket connection`

## Native commands missing from WebSocket dispatch

Present in native `generate_handler![]` but not routed in WS dispatch:
- `approve_codex_command`
- `check_codex_cli_auth`
- `check_codex_cli_installed`
- `check_git_identity`
- `check_mcp_health`
- `delete_cli_profile`
- `generate_pr_update_content`
- `generate_release_notes`
- `get_available_codex_versions`
- `get_jean_config`
- `get_mcp_servers`
- `git_stash`
- `git_stash_pop`
- `install_codex_cli`
- `list_github_releases`
- `list_workflow_runs`
- `open_branch_on_github`
- `regenerate_session_name`
- `save_cli_profile`
- `save_jean_config`
- `set_all_worktrees_for_polling`
- `set_git_identity`
- `set_pr_worktrees_for_polling`
- `set_session_backend`
- `set_session_provider`
- `update_pr_description`

Count: 26.
