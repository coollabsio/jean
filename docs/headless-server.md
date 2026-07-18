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

## Install the local development build

Install the Linux build dependencies once on Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y libssl-dev pkg-config
```

On a Linux host where `jean-server.service` already runs the binary at
`~/.local/bin/jean-server`, use:

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

| CLI | Environment | Default |
| --- | --- | --- |
| `--headless` | `JEAN_HEADLESS=1` | off |
| `--host <addr>` | `JEAN_HOST` | saved preference, normally `127.0.0.1` |
| `--port <port>` | `JEAN_PORT` | `3456` |
| `--token <token>` | `JEAN_TOKEN` | saved/generated token |
| `--no-token` | `JEAN_NO_TOKEN=1` | off |
| `--allow-unsafe-no-token` | `JEAN_ALLOW_UNSAFE_NO_TOKEN=1` | off |
| n/a | `JEAN_ALLOWED_ORIGINS` | same-origin only |

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

## Security recommendations

- Prefer `127.0.0.1` behind Caddy/Nginx, SSH tunnel, or Tailscale.
- Keep token auth enabled for every non-localhost bind.
- Use a long random token, for example `openssl rand -base64 32`.
- Set `JEAN_ALLOWED_ORIGINS=https://jean.example.com` only when you need cross-origin browser access; otherwise keep the default same-origin behavior.
