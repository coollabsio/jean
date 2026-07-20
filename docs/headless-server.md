# Jean Headless Server

Jean can run as a browser-accessible Tokio/Axum server with no Tauri, WebView,
GTK, or display-server dependency. `jean-core` owns shared state, commands,
events, persistence, projects, chat backends, terminals, background work, and
the HTTP/WebSocket protocol. `src-server` is the standalone server adapter.

## Start locally

When running a debug binary directly, build the browser bundle first. Jean
embeds `dist/` into the server binary at compile time, so production deploys
only need the compiled binary.

```bash
bun run build
cargo build --manifest-path src-server/Cargo.toml
```

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ./src-server/target/debug/jean-server --host 127.0.0.1 --port 3456
curl http://127.0.0.1:3456/healthz
```

You can also run the server entrypoint when packaged/available:

```bash
jean-server --host 127.0.0.1 --port 3456
```

For a production single-binary server:

```bash
bun run build
cargo build --release --manifest-path src-server/Cargo.toml
./src-server/target/release/jean-server --host 0.0.0.0 --port 3456 --token "$JEAN_TOKEN"
```

After the release build finishes, `dist/` is no longer needed on the target
server. Re-run `bun run build` before compiling whenever frontend code changes.

## Install on a server (release binary + systemd)

Use the production installer to download the latest `jean-server` release,
install the binary, write an env file, and register a systemd service.

**Interactive (recommended on a real terminal):** without `-y` / `--host` /
`--port`, the installer asks which interface to bind to (localhost, all
interfaces, primary LAN IP, Tailscale if detected, or a custom address) and
which port to use:

```bash
curl -fsSL https://raw.githubusercontent.com/coollabsio/jean/main/scripts/install-jean-server.sh | sudo bash
```

**Non-interactive:** pass `-y` and optionally predefine bind settings via flags
or env (`JEAN_HOST`, `JEAN_PORT`):

```bash
curl -fsSL https://raw.githubusercontent.com/coollabsio/jean/main/scripts/install-jean-server.sh | sudo bash -s -- -y
```

Or from a clone of this repo:

```bash
sudo ./scripts/install-jean-server.sh --host 127.0.0.1 --port 3456 -y
```

Common options:

```bash
# Bind on all interfaces with an explicit token
sudo ./scripts/install-jean-server.sh \
  --host 0.0.0.0 \
  --port 3456 \
  --token "$(openssl rand -base64 32)" \
  -y

# Bind only on the machine's Tailscale IP (auto-detected)
sudo ./scripts/install-jean-server.sh --host tailscale --port 3456 -y

# Bind only on the primary LAN IPv4
sudo ./scripts/install-jean-server.sh --host lan -y

# Install as the current user (user systemd unit under ~/.config/systemd/user)
./scripts/install-jean-server.sh --user-install --host 127.0.0.1 -y

# Pin a release
sudo ./scripts/install-jean-server.sh --version v0.1.66 -y

# Binary only (no service)
sudo ./scripts/install-jean-server.sh --no-service -y
```

`--host` accepts a concrete address or presets: `localhost` / `127.0.0.1`,
`all` / `public` / `0.0.0.0`, `lan` / `primary`, `tailscale` / `ts`, or any IP
or hostname.

Defaults:

| Item        | System install                 | `--user-install`                        |
| ----------- | ------------------------------ | --------------------------------------- |
| Binary      | `/usr/local/bin/jean-server`   | `~/.local/bin/jean-server`              |
| Env file    | `/etc/jean-server.env`         | `~/.config/jean-server/jean-server.env` |
| Service     | `jean-server.service` (system) | `jean-server.service` (user)            |
| Host / port | `127.0.0.1:3456` (or prompted) | same                                    |
| Token       | auto-generated (printed once)  | same                                    |

Re-running the installer reuses an existing `JEAN_TOKEN` from the env file unless
you pass `--token`. Data under `JEAN_DATA_DIR` / the default app-data directory is
left intact. Uninstall:

```bash
sudo ./scripts/install-jean-server.sh --uninstall -y
```

If systemd is not available, the script still installs the binary + env file and
prints an OpenRC example unit.

## Install the local development build

Install the Linux build dependencies once on Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y libssl-dev pkg-config
```

On a Linux host where `jean-server.service` already runs the binary at
`/usr/local/bin/jean-server`, use:

```bash
bun run install:local:server
tail -f tmp/install-local-server.log
```

The command runs in the background by default. It builds and embeds the current
frontend, compiles `src-server` in release mode, atomically replaces the binary,
and queues a systemd restart. The browser connection will briefly disconnect
while the service restarts. Use `bun run install:local:server:foreground` to
keep build output in the current terminal.

Override the defaults when the service uses a different unit or binary path:

```bash
JEAN_SERVER_INSTALL_PATH=/opt/jean/jean-server \
JEAN_SERVER_SERVICE=jean-dev.service \
bun run install:local:server
```

## Options and environment

| CLI                       | Environment                    | Default                                |
| ------------------------- | ------------------------------ | -------------------------------------- |
| `--headless`              | `JEAN_HEADLESS=1`              | off                                    |
| `--host <addr>`           | `JEAN_HOST`                    | saved preference, normally `127.0.0.1` |
| `--port <port>`           | `JEAN_PORT`                    | `3456`                                 |
| `--token <token>`         | `JEAN_TOKEN`                   | saved/generated token                  |
| `--no-token`              | `JEAN_NO_TOKEN=1`              | off                                    |
| `--allow-unsafe-no-token` | `JEAN_ALLOW_UNSAFE_NO_TOKEN=1` | off                                    |
| n/a                       | `JEAN_ALLOWED_ORIGINS`         | same-origin only                       |

By default a token is required (using `--token`, `JEAN_TOKEN`, or an auto-generated one); pass `--no-token` to disable it. `--token` and `--no-token` are mutually exclusive. Jean rejects `--no-token` with `--host 0.0.0.0` or `--host ::` unless `--allow-unsafe-no-token` is also set.

## Health checks

- `GET /healthz` — process is alive.
- `GET /readyz` — HTTP server is initialized and WebSocket broadcaster state is ready.

Authenticated endpoints accept either the existing `?token=...` query parameter or an HTTP bearer token:

```bash
curl -H "Authorization: Bearer $JEAN_TOKEN" http://127.0.0.1:3456/api/auth
curl "http://127.0.0.1:3456/api/init?token=$JEAN_TOKEN"
```

The browser UI still uses `/api/init`, `/api/auth`, and `/ws` from the same origin, so reverse proxies do not need to rewrite paths.

## systemd example

```ini
[Unit]
Description=Jean headless server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jean
Environment=JEAN_HOST=127.0.0.1
Environment=JEAN_PORT=3456
Environment=JEAN_TOKEN=change-me-long-random-token
ExecStart=/usr/local/bin/jean-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Jean loads the service user's interactive login-shell `PATH` at startup, so
browser terminals can find tools installed by shell setup scripts (for example
`~/.bun/bin/bun`) even though systemd itself provides a minimal environment.

## Docker notes

- The server Docker image is published by the Server Release workflow as
  `ghcr.io/<owner>/<repo>-server:<tag>`.
- The image launches `jean-server` directly and contains no GTK/WebKit/Xvfb packages.
- Bind to `0.0.0.0` inside the container, but keep token auth enabled.
- Mount Jean's app-data directory as a volume so projects, preferences, and sessions persist.
- Put TLS/auth in front of the container for internet exposure.

Example command:

```bash
docker run --rm \
  -e JEAN_HEADLESS=1 \
  -e JEAN_HOST=0.0.0.0 \
  -e JEAN_PORT=3456 \
  -e JEAN_TOKEN=change-me-long-random-token \
  -p 127.0.0.1:3456:3456 \
  -v jean-data:/home/jean/.local/share/com.jean.desktop \
  ghcr.io/OWNER/REPO-server:latest
```

## Reverse proxy

### Caddy

```caddyfile
jean.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3456
}
```

### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name jean.example.com;

  location / {
    proxy_pass http://127.0.0.1:3456;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Tailscale binding

Bind directly to the Tailscale IP and keep token auth enabled:

```bash
jean --headless --host 100.x.y.z --port 3456 --token "$JEAN_TOKEN"
```

## Server updates (bare-metal Linux)

`jean-server` can install a newer binary when you choose to from Web Access.
Nothing is installed in the background — apply only runs after you click
**Update & restart**.

| Piece           | Behavior                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Manifest        | `server-latest.json` on the latest GitHub release                                                              |
| Check           | Web Access calls `check_server_update` after connect and shows a toast if newer                                |
| Apply           | User clicks **Update & restart** → `apply_server_update`                                                       |
| Verify          | SHA-256 from the release manifest                                                                              |
| Restart         | `systemctl restart jean-server.service` when that unit is loaded (or `JEAN_SERVER_SERVICE`), otherwise re-exec |
| Containers      | Not supported — update the Docker/GHCR image instead                                                           |
| Active sessions | Apply is refused while chat sessions are running                                                               |

## Security recommendations

- Prefer `127.0.0.1` behind Caddy/Nginx, SSH tunnel, or Tailscale.
- Keep token auth enabled for every non-localhost bind.
- Use a long random token, for example `openssl rand -base64 32`.
- Set `JEAN_ALLOWED_ORIGINS=https://jean.example.com` only when you need additional cross-origin browser access; native Jean client origins are allowed by default.

## Connect from the native Jean app

In the desktop app, click the server icon in the title bar, choose **Add
remote**, and enter either the full Web Access URL (including `?token=...`) or
the server URL and token separately. Selecting the remote switches the entire
Jean backend while keeping the desktop app's bundled React UI and local native
shell capabilities. Commands and events for the selected instance travel over
HTTP/WebSocket. Select **Local** from the same dialog to return to the desktop
app's local backend.

Native Jean client origins are allowed automatically. HTTP and HTTPS server
URLs are both supported; keep token authentication enabled on remote servers.
