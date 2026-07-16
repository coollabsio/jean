# Jean Headless Server

Jean can run as a browser-accessible server without creating a visible Tauri WebView/window. This is intended first for Linux VPS, systemd, Docker, and Tailscale deployments.

On Linux, the Tauri/GTK runtime still needs a display backend to initialize even
when Jean is headless. The Docker image starts `Xvfb` automatically. For a raw
Linux binary on a server without `DISPLAY`, run it under `xvfb-run` or provide an
X/Wayland display.

## Linux prerequisites (Debian/Ubuntu)

When running a prebuilt Jean binary on a server without a desktop environment,
install the GTK/WebKit runtime libraries and the virtual display packages. These
packages match the Debian runtime used by Jean's server image:

```bash
sudo apt-get update
sudo apt-get install -y \
  libgtk-3-0 \
  libwebkit2gtk-4.1-0 \
  libayatana-appindicator3-1 \
  librsvg2-2 \
  xdg-utils \
  xvfb \
  xauth
```

If you are building Jean from source on the server, install the development
packages instead:

```bash
sudo apt-get update
sudo apt-get install -y \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  xdg-utils \
  xvfb \
  xauth
```

Package names can vary between Linux distributions and releases. Jean currently
builds against WebKitGTK 4.1.

## Start locally

When running a debug binary directly with `cargo build` / `./target/debug/jean`,
build the browser bundle first. Jean embeds `dist/` into the server binary at
compile time, so production deploys only need the compiled binary.

```bash
bun run build
cd src-tauri
cargo build --bin jean --bin jean-server
```

```bash
xvfb-run -a ./target/debug/jean --headless --host 127.0.0.1 --port 3456
curl http://127.0.0.1:3456/healthz
```

You can also run the server entrypoint when packaged/available:

```bash
xvfb-run -a jean-server --host 127.0.0.1 --port 3456
```

The desktop binary exposes the same server mode through `--headless`:

```bash
xvfb-run -a jean --headless --host 127.0.0.1 --port 3456
```

For a production single-binary server:

```bash
bun run build
cd src-tauri
cargo build --release --bin jean-server
xvfb-run -a ./target/release/jean-server --host 0.0.0.0 --port 3456 --token "$JEAN_TOKEN"
```

After `cargo build --release --bin jean-server` finishes, `dist/` is no longer
needed on the target server. Re-run `bun run build` before compiling whenever
frontend code changes.

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
ExecStart=/usr/bin/xvfb-run -a /usr/local/bin/jean-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Docker notes

- The server Docker image is published by the Server Release workflow as
  `ghcr.io/<owner>/<repo>-server:<tag>`.
- The image starts `Xvfb` internally before launching `jean-server`.
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
