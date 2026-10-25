# SSH tunnel remote transport

Desktop-only way to reach a jean-server that listens on `127.0.0.1` of a
remote Linux host. The Jean port is not published on the network. Web Access
and mobile keep using direct URLs.

This is the SSH half of issue #591. ntfy, webhooks, and other server-owned
notification providers are intentionally not included.

## Profile

`RemoteConnection.transport` is omitted or `"direct"` for an existing Web
Access URL. `"ssh"` stores `sshTunnel` (user, host, pinned host-key
fingerprint, ports, optional identity file) and persists
`url: "http://127.0.0.1"` with an empty token. That placeholder is not a fetch
target. The live URL is `http://127.0.0.1:<local-port>` from tunnel status.

Direct-URL tokens stay in `localStorage`. SSH tokens use the OS credential
store on macOS (Keychain) and Windows (Credential Manager): service
`coollabs.jean`, account `ssh-tunnel-<profile id>`. Linux writes a `0600`
`ssh-tunnel/secrets.json` file. The Secret Service crate needs a newer Rust
than this repository's toolchain, so it is not linked. The renderer hydrates
tokens into memory and never writes them back.

## Process

`SshTunnelSupervisor` (Tauri state) spawns `ssh -N` through
`jean_core::silent_command` so Windows does not flash a console. Host keys are
pinned in `{app data}/ssh-tunnel/known_hosts` after the user confirms the
SHA256 fingerprint from `ssh-keyscan`. The tunnel uses `StrictHostKeyChecking=yes`
and does not accept new keys on its own.

Retryable drops reconnect at 1s, 2s, 4s, 8s, 16s, then 30s. Host-key mismatch,
authentication failure, a missing `ssh` binary, and HTTP 401/403 stop until
the profile changes or the user retries. Exit, and ExitRequested when the app
is actually quitting, call `shutdown()`. A prevented exit (nonsurvivable
sessions) leaves the tunnels up. Removing a profile stops `ssh` and deletes
the secret.

Commands are desktop IPC only (`LOCAL_SHELL` / `DESKTOP_ONLY` in
`src/lib/transport.ts`). They are not registered on the jean-core HTTP
dispatch, and MCP stays enabled.

## Install via SSH

The native install path passes `viaTunnel: true`. The remote installer binds
`127.0.0.1`. The script is sent on stdin so the new token is not a local
`ssh` argument. The desktop command stores the token, waits until the tunnel
is healthy, then clears the token from the command result. An existing install
that fails the tunnel health check is reinstalled once, unless the failure is
host key or authentication.
