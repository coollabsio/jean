# CLIProxyAPI sidecar

CLIProxyAPI is an external MIT project: <https://github.com/router-for-me/CLIProxyAPI> ([license](https://github.com/router-for-me/CLIProxyAPI/blob/main/LICENSE)).

Jean installs and supervises the official release binary. It does not embed the Go SDK, does not store extra Claude or Codex subscription logins, and does not implement account failover. Pooling and round-robin stay inside CLIProxyAPI.

## Layout

Files live under `~/.jean/opinionated/cliproxyapi/`:

- `cli-proxy-api` — official release binary
- `config.yaml` — created only when missing. Default bind is `127.0.0.1:8317`, `management.allow-remote` is false, and discovery is off. Reinstall does not rewrite an existing config, so a user who sets another `server.host` keeps that choice.
- `client-key` / `management-key` — generated secrets (mode `0600` on Unix)
- `auths/` — CLIProxyAPI OAuth files for this sidecar
- `manifest.json` — version and whether Jean should resume the process on startup

## Providers

Install adds two profiles and does not change the user's default provider:

- Claude CLI profile `CLIProxyAPI` — `ANTHROPIC_BASE_URL=http://127.0.0.1:8317` plus the generated client key, stored as `~/.claude/settings.jean.cliproxyapi.json` and passed with the existing `--settings` path.
- Codex provider `CLIProxyAPI` — `base_url=http://127.0.0.1:8317/v1`, `wire_api=responses`, `env_key=CLIPROXYAPI_API_KEY`. Injected per session. `~/.codex/config.toml` is not rewritten.

Jean exports `CLIPROXYAPI_API_KEY` into Codex app-server and one-shot processes from `client-key`. A Codex server that was already running before install needs a new Jean process before it sees the key.

## Accounts

Preferences → Opinionated → CLIProxyAPI shows **Add Claude account** and **Add Codex account** once the sidecar is installed. Those buttons call `prepare_cliproxyapi_account_login`, which starts the sidecar when it is stopped, then opens Jean's login terminal on the managed binary:

```text
cli-proxy-api --config <jean config.yaml> -claude-login
cli-proxy-api --config <jean config.yaml> -codex-login
```

CLIProxyAPI opens the provider login and writes the OAuth file under `auths/`. Jean does not read those files, does not copy the tokens, and does not switch or round-robin accounts. The row only counts `*.json` names in that directory. **Open management** opens `http://127.0.0.1:8317/management.html` (key in `management-key`) and starts the sidecar first when it is stopped.

[EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) is a separate MIT desktop client with its own CLIProxyAPI lifecycle. Jean does not install it. The Opinionated row launches the binary Jean already supervises.
