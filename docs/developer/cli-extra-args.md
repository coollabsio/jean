# Extra CLI arguments per backend

Users can give extra flags to each backend CLI in **Settings > Backends > <backend> > Extra CLI arguments** (issue #335). Example: `--pure` for OpenCode 1.x, to start without external plugins.

## Storage

- `AppPreferences.cli_extra_args`: a map from the backend id (`claude`, `codex`, `opencode`, `cursor`, `pi`, `commandcode`, `grok`, `kimi`, `devin`, `antigravity`, `muse`) to one string. snake_case, `#[serde(default)]`.
- TypeScript: `cli_extra_args: Partial<Record<CliBackend, string>>` in `src/types/preferences.ts`.
- UI: `src/components/preferences/panes/CliExtraArgsSection.tsx`, shown on every CLI backend tab by `BackendsPane.tsx`. It saves through `patch_preferences`, so web access needs no new dispatch arm.

## Rules (`jean-core/src/chat/extra_args.rs`)

1. **Split**: `shell_words::split`. Quotes work. A bad quote is an error.
2. **Validate**: every token must be a flag (starts with `-`), or the value directly after a flag. `--` is not allowed. The characters `& | ^ < > %`, CR, LF and NUL are not allowed: on Windows, npm `.cmd` shims run through `cmd.exe /C` (`platform::cli_command`), where these are operators.
3. **Jean wins**: a user flag is dropped (with its value) when:
   - it is in the backend's reserved list (`reserved_flags`), or
   - Jean already passes the same flag on this spawn, unless the flag is repeatable (`repeatable_flags`, for example Codex and Muse `-c`, Claude `--add-dir`).
     A dropped flag is logged as a warning.
4. **No shell**: the result is passed as separate argv items. Detached spawns (`spawn_detached_process`, `spawn_detached_claude`) already shell-escape each argv item.
5. **Errors**: an invalid value fails the run with `Invalid extra CLI arguments for <backend> (Settings > Backends): ...`. Jean does not silently run without the flags.

## Flags that conflict with Jean

These are reserved and always dropped, because Jean parses the output, controls the execution mode, or owns the session or transport:

| Backend      | Reserved flags                                                                                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude       | `-p/--print`, `--output-format`, `--input-format`, `--json-schema`, `--replay-user-messages`, `--include-partial-messages`, `-r/--resume`, `-c/--continue`, `--session-id`, `--fork-session`, `--permission-mode`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-prompt-tool` |
| Codex        | `--json`, `--experimental-json`, `--output-schema`, `-o/--output-last-message`, `-s/--sandbox`, `-a/--ask-for-approval`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--listen`, `--print-startup-config`, `--startup-sign-out`                                                              |
| OpenCode     | `--hostname`, `--port`, `--stdio`, `--service`, `--cors`                                                                                                                                                                                                                                                                |
| Cursor       | `-p/--print`, `--output-format`, `--stream-partial-output`, `--resume`, `-f/--force`, `--yolo`, `--mode`, `--sandbox`, `--trust`, `--workspace`                                                                                                                                                                         |
| PI           | `--mode`, `-p/--print`, `--session`, `--no-session`, `-c/--continue`                                                                                                                                                                                                                                                    |
| Command Code | `-p/--print`, `--output-format`, `--resume`, `--continue`, `--yolo`, `--auto-accept`, `--dangerously-skip-permissions`, `--permission-mode`                                                                                                                                                                             |
| Grok         | `-p/--print`, `--output-format`, `--resume`, `--yolo`, `--permission-mode`, `--sandbox`, `--always-approve`, `--cwd`, `--prompt-file`, `--no-plan`, `--leader`, `--no-leader`                                                                                                                                           |
| Kimi         | `--print`, `--output-format`, `--input-format`, `--yolo`, `-y/--yes`, `--session`, `--continue`                                                                                                                                                                                                                         |
| Devin        | `-p/--print`, `--output-format`, `--permission-mode`, `--dangerously-skip-permissions`, `--resume`, `--continue`, `--cloud`                                                                                                                                                                                             |
| Antigravity  | `-p/--prompt`, `-o/--output-format`, `-y/--yolo`, `--approval-mode`, `-r/--resume`, `--mode`, `--sandbox`, `--dangerously-skip-permissions`, `--conversation`, `--json-schema`                                                                                                                                          |
| Muse         | `--json`, `--permission-profile`, `--output-schema`, `--trust-workspace`, `--disable-request-user-input`, `--disable-sandbox`, `--yolo`                                                                                                                                                                                 |

Flags Jean sets on a spawn, such as `--model`, `--effort`, `--tools` or `--max-turns`, are also dropped on that spawn. Use Jean's model and effort pickers for those.

The filter matches exact flag names only. A short alias that is not in the list, or a combined short flag (`-abc`), is not detected. The OpenCode agent (from the execution mode) is set through the HTTP API, not argv, so a user flag cannot change it.

## Where the args are added

Add the args at every new spawn site of a backend CLI, after Jean's flags and before any trailing positional (prompt, `-`, `stdio`). Use `apply_extra_args` for a `Command`, `extra_args_for` for a `Vec<String>`, and `insert_extra_os_args` to insert after a subcommand.

| Backend      | Chat                                                              | One-shot (magic prompts)                                                                                                                                      |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude       | `chat/claude.rs` (`execute_claude_detached`)                      | `projects/commands.rs` (`claude_one_shot_args`: PR, commit, review, release notes), `chat/commands.rs` (summary), `chat/naming.rs`, `projects/checkpoints.rs` |
| Codex        | `chat/codex_server.rs` (`codex app-server`, after the subcommand) | `chat/codex.rs` (`execute_one_shot_codex`), `projects/commands.rs` (Codex review), after `exec`                                                               |
| OpenCode     | `opencode_server/mod.rs` (`opencode serve`)                       | Same server (one-shots use the HTTP API)                                                                                                                      |
| Cursor       | `chat/cursor.rs`                                                  | `chat/cursor.rs`                                                                                                                                              |
| PI           | `chat/pi.rs` (RPC host argv, Windows fallback)                    | `chat/pi.rs`                                                                                                                                                  |
| Command Code | `chat/commandcode.rs`                                             | `chat/commandcode.rs`                                                                                                                                         |
| Grok         | `chat/grok.rs` (`grok agent`, before `stdio`)                     | `chat/grok.rs`                                                                                                                                                |
| Kimi         | `chat/kimi.rs` (host argv `--kimi-arg`, Windows attached path)    | `chat/kimi.rs`                                                                                                                                                |
| Devin        | `chat/devin.rs` (`devin acp`)                                     | none (Devin has no one-shot path)                                                                                                                             |
| Antigravity  | `chat/antigravity.rs`                                             | `chat/antigravity.rs`                                                                                                                                         |
| Muse         | `chat/muse.rs` (`muse serve`, host argv `--muse-arg`)             | `chat/muse.rs` (`muse exec`)                                                                                                                                  |

Shared servers (OpenCode server, Codex app-server) read the value when they start. A change applies after the server restarts.

Not covered: install, update, version, auth/login, MCP health and MCP login commands, plugin installs (`opinionated/`), and the Muse model catalog probe. These are not agent runs, and a user flag could break them.
