# Antigravity CLI backend migration

Jean replaces its unreleased Gemini CLI backend with Google's Antigravity CLI. The integration uses the official native `agy` binary and does not use the unrelated npm package.

## Verified CLI contract

- Install: Google's native scripts support `--dir`, which Jean uses for its managed installation.
- Auth: start `agy` in Jean's terminal. Antigravity stores credentials in the operating system keyring. `agy models` provides a non-mutating readiness check.
- Chat: `agy -p --output-format stream-json` emits NDJSON `init`, `step_update`, and `result` events.
- Resume: persist `conversation_id` and pass it to `--conversation` on the next turn.
- Modes: Plan uses `--mode plan`; Build uses `--mode accept-edits`; Yolo also uses `--dangerously-skip-permissions`.
- One-shot work: `--output-format json --json-schema` returns the validated value as `structured_output`.
- Models: `agy models` returns account-specific model slugs and labels.
- MCP: read `.agents/mcp_config.json` and `~/.gemini/config/mcp_config.json`. The current headless CLI has no separate MCP health command, so Jean reports configured or disabled state only.

## Compatibility

Old persisted `gemini` backend values, Gemini session IDs, selected model, CLI source, and steering preference are accepted as migration inputs. Jean writes only Antigravity names after migration.

## Official references

- https://antigravity.google/product/antigravity-cli
- https://antigravity.google/docs/cli/install
- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/conversations
- https://antigravity.google/docs/cli/permissions
- https://antigravity.google/docs/cli/mcp
- https://antigravity.google/docs/cli/gcli-migration
