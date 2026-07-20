#!/usr/bin/env bash
# Install jean-server from GitHub releases, configure env, and register a service.
#
# Examples:
#   curl -fsSL https://raw.githubusercontent.com/coollabsio/jean/main/scripts/install-jean-server.sh | sudo bash
#   sudo ./scripts/install-jean-server.sh --host 0.0.0.0 --port 3456
#   sudo ./scripts/install-jean-server.sh --host tailscale --port 3456
#   ./scripts/install-jean-server.sh --user-install --host 127.0.0.1
#   sudo ./scripts/install-jean-server.sh --version v0.1.66 --token "$JEAN_TOKEN"
#   sudo ./scripts/install-jean-server.sh -y   # non-interactive (localhost:3456)
#   sudo ./scripts/install-jean-server.sh --uninstall
#
# Environment overrides (same names as flags when useful):
#   JEAN_REPO, JEAN_VERSION, JEAN_HOST, JEAN_PORT, JEAN_TOKEN
#   JEAN_SERVER_INSTALL_PATH, JEAN_SERVER_SERVICE, JEAN_SERVER_USER
#   JEAN_SERVER_ENV_FILE, JEAN_SERVER_DATA_DIR

set -euo pipefail

REPO="${JEAN_REPO:-coollabsio/jean}"
VERSION="${JEAN_VERSION:-latest}"
# Empty until flags/env/prompt resolve them; defaults applied later.
HOST="${JEAN_HOST:-}"
PORT="${JEAN_PORT:-}"
TOKEN="${JEAN_TOKEN:-}"
INSTALL_PATH="${JEAN_SERVER_INSTALL_PATH:-}"
SERVICE_NAME="${JEAN_SERVER_SERVICE:-jean-server}"
SERVICE_USER="${JEAN_SERVER_USER:-}"
ENV_FILE="${JEAN_SERVER_ENV_FILE:-}"
DATA_DIR="${JEAN_SERVER_DATA_DIR:-}"
GITHUB_API="${GITHUB_API:-https://api.github.com}"
GITHUB_DOWNLOAD="${GITHUB_DOWNLOAD:-https://github.com}"

DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="3456"

USER_INSTALL=0
NO_SERVICE=0
START=1
ENABLE=1
ASSUME_YES=0
UNINSTALL=0
LOCAL_TARBALL=""
PRINT_TOKEN=1
HOST_EXPLICIT=0
PORT_EXPLICIT=0

# Treat env overrides as explicit (skip interactive prompts for those values).
if [[ -n "${JEAN_HOST:-}" ]]; then HOST_EXPLICIT=1; fi
if [[ -n "${JEAN_PORT:-}" ]]; then PORT_EXPLICIT=1; fi

usage() {
  cat <<'EOF'
Usage: install-jean-server.sh [options]

Install jean-server (Linux amd64/arm64), write an env file, and register systemd
(or print an OpenRC unit when systemd is unavailable).

When run interactively (TTY available and not -y), the installer asks which
interface to bind to (localhost, all interfaces, LAN IP, Tailscale, or custom)
and which port to use, unless --host / --port / JEAN_HOST / JEAN_PORT are set.

Options:
  --version <tag|latest>   Release tag (default: latest). Example: v0.1.66
  --host <addr|preset>     Bind address or preset (skips interface prompt):
                             127.0.0.1 | localhost  — loopback only (default)
                             0.0.0.0 | all | public — all interfaces
                             lan | primary          — primary LAN IPv4
                             tailscale | ts         — Tailscale IPv4
                             <ip or hostname>       — exact bind address
  --port <port>            Listen port (default: 3456; skips port prompt)
  --token <token>          Auth token (default: auto-generate)
  --no-token               Disable token auth (unsafe on public binds)
  --install-path <path>    Binary path (default: /usr/local/bin/jean-server,
                           or ~/.local/bin/jean-server with --user-install)
  --user <name>            Systemd service user (default: root, or current user
                           with --user-install)
  --user-install           Install for the current user (user systemd unit)
  --service-name <name>    Unit name without .service (default: jean-server)
  --env-file <path>        Environment file path
  --data-dir <path>        JEAN_DATA_DIR for projects/prefs
  --repo <owner/name>      GitHub repo (default: coollabsio/jean)
  --tarball <path>         Install from a local release .tar.gz instead of GitHub
  --no-service             Install binary + env only (skip service registration)
  --no-start               Do not start the service after install
  --no-enable              Do not enable the service at boot
  --uninstall              Remove binary, env file, and service unit
  -y, --yes                Non-interactive (assume yes; use defaults / flags)
  -h, --help               Show this help

Environment:
  JEAN_REPO JEAN_VERSION JEAN_HOST JEAN_PORT JEAN_TOKEN
  JEAN_SERVER_INSTALL_PATH JEAN_SERVER_SERVICE JEAN_SERVER_USER
  JEAN_SERVER_ENV_FILE JEAN_SERVER_DATA_DIR
EOF
}

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

is_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]]; }

detect_arch() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) die "Unsupported architecture: $machine (need x86_64 or aarch64)" ;;
  esac
}

normalize_version() {
  # v0.1.66 -> 0.1.66 ; latest stays latest until resolved
  local v="$1"
  if [[ "$v" == latest ]]; then
    echo "latest"
  else
    echo "${v#v}"
  fi
}

resolve_latest_tag() {
  need_cmd curl
  local tag
  tag="$(
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: jean-server-installer" \
      "${GITHUB_API}/repos/${REPO}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n1
  )"
  [[ -n "$tag" ]] || die "Could not resolve latest release tag for ${REPO}"
  echo "$tag"
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  elif [[ -r /dev/urandom ]]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  else
    die "Need openssl or /dev/urandom to generate a token"
  fi
}

download() {
  local url="$1"
  local out="$2"
  curl -fsSL \
    -H "User-Agent: jean-server-installer" \
    -o "$out" \
    "$url"
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "Need sha256sum or shasum to verify downloads"
  fi
}

verify_sha256() {
  local file="$1"
  local expected_file="$2"
  local expected actual
  expected="$(awk '{print $1; exit}' "$expected_file" | tr '[:upper:]' '[:lower:]')"
  actual="$(sha256_file "$file" | tr '[:upper:]' '[:lower:]')"
  [[ "$expected" == "$actual" ]] || die "Checksum mismatch for $(basename "$file") (expected $expected, got $actual)"
}

atomic_install_binary() {
  local src="$1"
  local dest="$2"
  local dir temp
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  temp="${dest}.new-$$"
  cp "$src" "$temp"
  chmod 755 "$temp"
  mv -f "$temp" "$dest"
}

extract_binary_from_tarball() {
  local tarball="$1"
  local out_dir="$2"
  local extracted name

  mkdir -p "$out_dir"
  tar -xzf "$tarball" -C "$out_dir"

  # Prefer jean-server, else jean-server-linux-*
  if [[ -f "$out_dir/jean-server" ]]; then
    echo "$out_dir/jean-server"
    return
  fi

  extracted="$(find "$out_dir" -type f \( -name 'jean-server' -o -name 'jean-server-linux-*' \) | head -n1 || true)"
  [[ -n "$extracted" ]] || die "jean-server binary not found inside tarball"
  echo "$extracted"
}

write_env_file() {
  local path="$1"
  local host="$2"
  local port="$3"
  local token="$4"
  local no_token="$5"
  local data_dir="$6"
  local dir

  dir="$(dirname "$path")"
  mkdir -p "$dir"

  umask 077
  {
    echo "# Generated by install-jean-server.sh — do not commit"
    echo "JEAN_HOST=${host}"
    echo "JEAN_PORT=${port}"
    if [[ "$no_token" == "1" ]]; then
      echo "JEAN_NO_TOKEN=1"
    else
      echo "JEAN_TOKEN=${token}"
    fi
    if [[ -n "$data_dir" ]]; then
      echo "JEAN_DATA_DIR=${data_dir}"
    fi
  } >"$path"
  chmod 600 "$path"
}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system || -d /sys/fs/cgroup/systemd || -d /sys/fs/cgroup/system.slice ]]
}

write_systemd_unit() {
  local unit_path="$1"
  local binary="$2"
  local env_file="$3"
  local user="$4"
  local description="Jean headless server"

  mkdir -p "$(dirname "$unit_path")"
  cat >"$unit_path" <<EOF
[Unit]
Description=${description}
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
EnvironmentFile=-${env_file}
ExecStart=${binary} --headless
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
}

write_user_systemd_unit() {
  local unit_path="$1"
  local binary="$2"
  local env_file="$3"

  mkdir -p "$(dirname "$unit_path")"
  cat >"$unit_path" <<EOF
[Unit]
Description=Jean headless server
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-${env_file}
ExecStart=${binary} --headless
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
}

print_openrc_unit() {
  local binary="$1"
  local env_file="$2"
  local user="$3"
  cat <<EOF

# systemd not detected. Example OpenRC service (/etc/init.d/jean-server):
#
# #!/sbin/openrc-run
# name="jean-server"
# command="${binary}"
# command_args="--headless"
# command_user="${user}"
# command_background=true
# pidfile="/run/\${RC_SVCNAME}.pid"
# start_stop_daemon_args="--env-file ${env_file}"
#
# depend() { need net; }
#
# Then: rc-update add jean-server default && rc-service jean-server start
EOF
}

uninstall_all() {
  local binary="$1"
  local env_file="$2"
  local service="$3"
  local user_install="$4"

  log "Stopping service (if present)"
  if [[ "$user_install" == "1" ]]; then
    systemctl --user stop "${service}.service" 2>/dev/null || true
    systemctl --user disable "${service}.service" 2>/dev/null || true
    rm -f "${HOME}/.config/systemd/user/${service}.service"
    systemctl --user daemon-reload 2>/dev/null || true
  elif systemd_available; then
    systemctl stop "${service}.service" 2>/dev/null || true
    systemctl disable "${service}.service" 2>/dev/null || true
    rm -f "/etc/systemd/system/${service}.service"
    systemctl daemon-reload 2>/dev/null || true
  fi

  log "Removing binary and env file"
  rm -f "$binary"
  rm -f "$env_file"
  log "Uninstall complete (data dir left intact)"
}

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" == "1" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "Refusing interactive prompt on non-TTY; pass -y/--yes"
  fi
  local answer
  read -r -p "${prompt} [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" || "$answer" == "yes" ]]
}

# Prefer /dev/tty so curl|bash installs can still prompt when a terminal is attached.
can_prompt() {
  [[ "$ASSUME_YES" != "1" ]] && [[ -r /dev/tty ]] && [[ -w /dev/tty ]]
}

prompt_read() {
  # usage: prompt_read VAR "prompt text"
  local __var="$1"
  local __prompt="$2"
  local __value=""
  if [[ -r /dev/tty ]]; then
    # shellcheck disable=SC2162
    read -r -p "$__prompt" __value </dev/tty || true
  else
    # shellcheck disable=SC2162
    read -r -p "$__prompt" __value || true
  fi
  printf -v "$__var" '%s' "$__value"
}

is_wildcard_bind() {
  case "$1" in
    0.0.0.0|::|\*|all|public) return 0 ;;
    *) return 1 ;;
  esac
}

is_loopback_bind() {
  case "$1" in
    127.0.0.1|::1|localhost) return 0 ;;
    *) return 1 ;;
  esac
}

validate_port() {
  local p="$1"
  [[ "$p" =~ ^[0-9]+$ ]] || return 1
  ((10#$p >= 1 && 10#$p <= 65535))
}

# Primary non-loopback IPv4 used for outbound traffic (LAN/public interface).
detect_lan_ipv4() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(
      ip -4 route get 1.1.1.1 2>/dev/null \
        | awk '{
            for (i = 1; i <= NF; i++) {
              if ($i == "src") { print $(i + 1); exit }
            }
          }'
    )"
  fi
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  # Reject loopback / empty
  if [[ -n "$ip" ]] && ! is_loopback_bind "$ip"; then
    echo "$ip"
  fi
}

detect_tailscale_ipv4() {
  local ip=""
  if command -v tailscale >/dev/null 2>&1; then
    ip="$(tailscale ip -4 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  fi
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(
      ip -4 -o addr show dev tailscale0 2>/dev/null \
        | awk '{print $4}' \
        | cut -d/ -f1 \
        | head -n1
    )"
  fi
  # Tailscale CGNAT is 100.64.0.0/10
  if [[ -n "$ip" && "$ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\. ]]; then
    echo "$ip"
    return
  fi
  if [[ -n "$ip" && "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "$ip"
  fi
}

format_host_for_url() {
  local h="$1"
  if [[ "$h" == *:* && "$h" != \[* ]]; then
    echo "[${h}]"
  else
    echo "$h"
  fi
}

resolve_host_preset() {
  # Resolve symbolic presets / aliases to a concrete bind address.
  # Prints the resolved host on stdout.
  local raw="$1"
  local lower resolved
  lower="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    ""|localhost|loopback|local-only)
      echo "127.0.0.1"
      ;;
    127.0.0.1|::1)
      echo "$raw"
      ;;
    0.0.0.0|::|\*|all|any|public|everywhere)
      # Keep IPv6 wildcard if the user typed it; map aliases to IPv4 any.
      if [[ "$raw" == "::" ]]; then
        echo "::"
      else
        echo "0.0.0.0"
      fi
      ;;
    lan|primary)
      resolved="$(detect_lan_ipv4 || true)"
      [[ -n "$resolved" ]] || die "Could not detect a LAN IPv4 address. Pass --host <ip> explicitly."
      echo "$resolved"
      ;;
    tailscale|ts|tailnet)
      resolved="$(detect_tailscale_ipv4 || true)"
      [[ -n "$resolved" ]] || die "Could not detect a Tailscale IPv4 address (is Tailscale up?). Pass --host <ip> or install/run tailscale."
      echo "$resolved"
      ;;
    *)
      # Treat as a literal IP or hostname.
      echo "$raw"
      ;;
  esac
}

prompt_bind_settings() {
  # Interactive host/port selection. Only runs when values were not pre-set.
  local lan_ip ts_ip choice custom default_choice port_in
  local -a menu_labels=()
  local -a menu_values=()

  if [[ "$HOST_EXPLICIT" == "1" && "$PORT_EXPLICIT" == "1" ]]; then
    return
  fi

  if ! can_prompt; then
    # Non-interactive path: defaults unless already set.
    if [[ "$HOST_EXPLICIT" != "1" || -z "$HOST" ]]; then
      HOST="$DEFAULT_HOST"
      HOST_EXPLICIT=1
    fi
    if [[ "$PORT_EXPLICIT" != "1" || -z "$PORT" ]]; then
      PORT="$DEFAULT_PORT"
      PORT_EXPLICIT=1
    fi
    return
  fi

  lan_ip="$(detect_lan_ipv4 || true)"
  ts_ip="$(detect_tailscale_ipv4 || true)"

  if [[ "$HOST_EXPLICIT" != "1" || -z "$HOST" ]]; then
    echo
    log "Choose which interface jean-server should bind to"
    echo "  Jean will listen only on the address you pick."
    echo "  Use \"all interfaces\" to accept LAN/public connections (token auth stays on)."
    echo

    menu_labels+=("Localhost only (127.0.0.1) — this machine only [default]")
    menu_values+=("127.0.0.1")

    menu_labels+=("All interfaces (0.0.0.0) — LAN / public IP / port-forward")
    menu_values+=("0.0.0.0")

    if [[ -n "$lan_ip" ]]; then
      menu_labels+=("Primary LAN address (${lan_ip})")
      menu_values+=("$lan_ip")
    fi

    if [[ -n "$ts_ip" ]]; then
      menu_labels+=("Tailscale (${ts_ip})")
      menu_values+=("$ts_ip")
    else
      menu_labels+=("Tailscale (not detected — pick to retry / error)")
      menu_values+=("tailscale")
    fi

    menu_labels+=("Custom IP or hostname")
    menu_values+=("custom")

    local i
    for i in "${!menu_labels[@]}"; do
      printf '  %d) %s\n' "$((i + 1))" "${menu_labels[$i]}"
    done
    echo

    default_choice=1
    prompt_read choice "Bind interface [${default_choice}]: "
    choice="${choice:-$default_choice}"

    if [[ ! "$choice" =~ ^[0-9]+$ ]] || ((choice < 1 || choice > ${#menu_values[@]})); then
      die "Invalid choice: ${choice}"
    fi

    HOST="${menu_values[$((choice - 1))]}"
    if [[ "$HOST" == "custom" ]]; then
      prompt_read custom "Enter bind IP or hostname: "
      custom="$(printf '%s' "$custom" | tr -d '[:space:]')"
      [[ -n "$custom" ]] || die "Bind address cannot be empty"
      HOST="$custom"
    fi
    HOST="$(resolve_host_preset "$HOST")"
    HOST_EXPLICIT=1
    log "Bind address: ${HOST}"
  fi

  if [[ "$PORT_EXPLICIT" != "1" || -z "$PORT" ]]; then
    prompt_read port_in "Listen port [${DEFAULT_PORT}]: "
    port_in="${port_in:-$DEFAULT_PORT}"
    port_in="$(printf '%s' "$port_in" | tr -d '[:space:]')"
    validate_port "$port_in" || die "Invalid port: ${port_in} (need 1-65535)"
    PORT="$port_in"
    PORT_EXPLICIT=1
    log "Listen port: ${PORT}"
  fi
}

# --- parse args ---
NO_TOKEN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --host)
      [[ $# -ge 2 ]] || die "--host requires an address or preset"
      HOST="$2"
      HOST_EXPLICIT=1
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port requires a port number"
      PORT="$2"
      PORT_EXPLICIT=1
      shift 2
      ;;
    --token) TOKEN="$2"; shift 2 ;;
    --no-token) NO_TOKEN=1; shift ;;
    --install-path) INSTALL_PATH="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --user-install) USER_INSTALL=1; shift ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --tarball) LOCAL_TARBALL="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-start) START=0; shift ;;
    --no-enable) ENABLE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || die "This installer only supports Linux."

# Defaults that depend on install mode
if [[ "$USER_INSTALL" == "1" ]]; then
  INSTALL_PATH="${INSTALL_PATH:-$HOME/.local/bin/jean-server}"
  ENV_FILE="${ENV_FILE:-$HOME/.config/jean-server/jean-server.env}"
  SERVICE_USER="${SERVICE_USER:-$(id -un)}"
  DATA_DIR="${DATA_DIR:-$HOME/.local/share/com.jean.desktop}"
else
  INSTALL_PATH="${INSTALL_PATH:-/usr/local/bin/jean-server}"
  ENV_FILE="${ENV_FILE:-/etc/jean-server.env}"
  SERVICE_USER="${SERVICE_USER:-root}"
fi

# Strip accidental .service suffix
SERVICE_NAME="${SERVICE_NAME%.service}"

if [[ "$UNINSTALL" == "1" ]]; then
  if [[ "$USER_INSTALL" != "1" ]] && ! is_root; then
    die "Uninstall of system install requires root (or use --user-install)"
  fi
  uninstall_all "$INSTALL_PATH" "$ENV_FILE" "$SERVICE_NAME" "$USER_INSTALL"
  exit 0
fi

if [[ "$USER_INSTALL" != "1" ]] && ! is_root; then
  die "System install requires root. Re-run with sudo, or pass --user-install."
fi

need_cmd curl
need_cmd tar
need_cmd uname

# Resolve bind host/port (interactive menu, presets, or defaults).
prompt_bind_settings
if [[ "$HOST_EXPLICIT" == "1" && -n "$HOST" ]]; then
  HOST="$(resolve_host_preset "$HOST")"
fi
HOST="${HOST:-$DEFAULT_HOST}"
PORT="${PORT:-$DEFAULT_PORT}"
validate_port "$PORT" || die "Invalid port: ${PORT} (need 1-65535)"

# Validate host/token safety similar to jean-server
if [[ "$NO_TOKEN" == "1" ]] && is_wildcard_bind "$HOST"; then
  die "Refusing --no-token with public bind host ${HOST}. Use a token or bind to 127.0.0.1."
fi

# Token resolution:
# 1) --no-token
# 2) --token / JEAN_TOKEN (already in TOKEN)
# 3) existing env file on reinstall
# 4) freshly generated (printed once)
PRINT_TOKEN=0
if [[ "$NO_TOKEN" == "1" ]]; then
  TOKEN=""
elif [[ -n "$TOKEN" ]]; then
  : # explicit token from flag/env — keep private
elif [[ -f "$ENV_FILE" ]]; then
  existing="$(sed -n 's/^JEAN_TOKEN=//p' "$ENV_FILE" | head -n1 || true)"
  if [[ -n "$existing" ]]; then
    TOKEN="$existing"
    log "Reusing token from existing env file"
  fi
fi

if [[ "$NO_TOKEN" != "1" && -z "$TOKEN" ]]; then
  TOKEN="$(generate_token)"
  PRINT_TOKEN=1
fi

ARCH="$(detect_arch)"
ASSET_ARCH="linux-${ARCH}"

TMPDIR_INSTALL="$(mktemp -d "${TMPDIR:-/tmp}/jean-server-install.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_INSTALL"; }
trap cleanup EXIT

TARBALL_PATH=""
VERSION_NUM=""
TAG=""

if [[ -n "$LOCAL_TARBALL" ]]; then
  [[ -f "$LOCAL_TARBALL" ]] || die "Tarball not found: $LOCAL_TARBALL"
  TARBALL_PATH="$LOCAL_TARBALL"
  VERSION_NUM="$(normalize_version "$VERSION")"
  if [[ "$VERSION_NUM" == "latest" ]]; then
    VERSION_NUM="local"
  fi
  log "Using local tarball ${LOCAL_TARBALL}"
else
  if [[ "$VERSION" == "latest" ]]; then
    log "Resolving latest release for ${REPO}"
    TAG="$(resolve_latest_tag)"
  else
    TAG="$VERSION"
    [[ "$TAG" == v* ]] || TAG="v${TAG}"
  fi
  VERSION_NUM="$(normalize_version "$TAG")"
  ASSET="jean-server-${ASSET_ARCH}-${VERSION_NUM}.tar.gz"
  BASE_URL="${GITHUB_DOWNLOAD}/${REPO}/releases/download/${TAG}"
  TARBALL_URL="${BASE_URL}/${ASSET}"
  SHA_URL="${TARBALL_URL}.sha256"

  log "Downloading ${ASSET} (${TAG})"
  TARBALL_PATH="${TMPDIR_INSTALL}/${ASSET}"
  SHA_PATH="${TMPDIR_INSTALL}/${ASSET}.sha256"
  download "$TARBALL_URL" "$TARBALL_PATH" || die "Download failed: ${TARBALL_URL}"
  if download "$SHA_URL" "$SHA_PATH"; then
    log "Verifying SHA-256"
    verify_sha256 "$TARBALL_PATH" "$SHA_PATH"
  else
    warn "No .sha256 asset found; skipping checksum verification"
  fi
fi

log "Extracting binary"
EXTRACT_DIR="${TMPDIR_INSTALL}/extract"
BINARY_SRC="$(extract_binary_from_tarball "$TARBALL_PATH" "$EXTRACT_DIR")"

log "Installing binary to ${INSTALL_PATH}"
atomic_install_binary "$BINARY_SRC" "$INSTALL_PATH"

if [[ -n "$DATA_DIR" ]]; then
  mkdir -p "$DATA_DIR"
  if [[ "$SERVICE_USER" != "root" && "$USER_INSTALL" != "1" ]]; then
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "$DATA_DIR" 2>/dev/null || \
      chown -R "$SERVICE_USER" "$DATA_DIR" 2>/dev/null || true
  fi
fi

log "Writing env file ${ENV_FILE}"
write_env_file "$ENV_FILE" "$HOST" "$PORT" "$TOKEN" "$NO_TOKEN" "$DATA_DIR"

if [[ "$NO_SERVICE" == "1" ]]; then
  log "Skipping service registration (--no-service)"
else
  if [[ "$USER_INSTALL" == "1" ]]; then
    need_cmd systemctl
    UNIT_PATH="${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
    log "Writing user systemd unit ${UNIT_PATH}"
    write_user_systemd_unit "$UNIT_PATH" "$INSTALL_PATH" "$ENV_FILE"
    systemctl --user daemon-reload
    if [[ "$ENABLE" == "1" ]]; then
      systemctl --user enable "${SERVICE_NAME}.service"
    fi
    if [[ "$START" == "1" ]]; then
      systemctl --user restart "${SERVICE_NAME}.service"
    fi
    log "User service: systemctl --user status ${SERVICE_NAME}"
    warn "Enable lingering so the service survives logout: loginctl enable-linger $(id -un)"
  elif systemd_available; then
    UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
    log "Writing systemd unit ${UNIT_PATH}"
    write_systemd_unit "$UNIT_PATH" "$INSTALL_PATH" "$ENV_FILE" "$SERVICE_USER"
    systemctl daemon-reload
    if [[ "$ENABLE" == "1" ]]; then
      systemctl enable "${SERVICE_NAME}.service"
    fi
    if [[ "$START" == "1" ]]; then
      systemctl restart "${SERVICE_NAME}.service"
    fi
    log "Service: systemctl status ${SERVICE_NAME}"
  else
    warn "systemd not detected"
    print_openrc_unit "$INSTALL_PATH" "$ENV_FILE" "$SERVICE_USER"
  fi
fi

# Health probe (best-effort)
HEALTH_HOST="$HOST"
if is_wildcard_bind "$HEALTH_HOST"; then
  HEALTH_HOST="127.0.0.1"
fi

if [[ "$START" == "1" && "$NO_SERVICE" != "1" ]]; then
  sleep 1
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 3 "http://$(format_host_for_url "$HEALTH_HOST"):${PORT}/healthz" >/dev/null 2>&1; then
      log "Health check OK on port ${PORT}"
    else
      warn "Health check did not succeed yet (service may still be starting). Try: curl http://$(format_host_for_url "$HEALTH_HOST"):${PORT}/readyz"
    fi
  fi
fi

# Build a useful list of URLs to print after install.
DISPLAY_HOSTS=()
if is_wildcard_bind "$HOST"; then
  DISPLAY_HOSTS+=("127.0.0.1")
  lan_display="$(detect_lan_ipv4 || true)"
  ts_display="$(detect_tailscale_ipv4 || true)"
  [[ -n "$lan_display" ]] && DISPLAY_HOSTS+=("$lan_display")
  [[ -n "$ts_display" ]] && DISPLAY_HOSTS+=("$ts_display")
  # Fallback placeholder if we could not detect any non-loopback address.
  if [[ ${#DISPLAY_HOSTS[@]} -eq 1 ]]; then
    DISPLAY_HOSTS+=("<server-ip>")
  fi
else
  DISPLAY_HOSTS+=("$HOST")
fi

echo
log "jean-server installed"
echo "  binary : ${INSTALL_PATH}"
echo "  env    : ${ENV_FILE}"
echo "  bind   : ${HOST}:${PORT}"
if [[ "$NO_TOKEN" == "1" ]]; then
  echo "  token  : (disabled)"
elif [[ "$PRINT_TOKEN" == "1" ]]; then
  echo "  token  : ${TOKEN}"
  echo "  (save this token; it is also in ${ENV_FILE})"
else
  echo "  token  : (from env file / flag; not printed)"
fi
echo
echo "Open Web Access:"
for dh in "${DISPLAY_HOSTS[@]}"; do
  url_host="$(format_host_for_url "$dh")"
  echo "  http://${url_host}:${PORT}/"
  if [[ "$NO_TOKEN" != "1" && "$PRINT_TOKEN" == "1" ]]; then
    echo "  http://${url_host}:${PORT}/?token=${TOKEN}"
  fi
done
echo
echo "Useful commands:"
if [[ "$USER_INSTALL" == "1" ]]; then
  echo "  systemctl --user status ${SERVICE_NAME}"
  echo "  systemctl --user restart ${SERVICE_NAME}"
  echo "  journalctl --user -u ${SERVICE_NAME} -f"
else
  echo "  systemctl status ${SERVICE_NAME}"
  echo "  systemctl restart ${SERVICE_NAME}"
  echo "  journalctl -u ${SERVICE_NAME} -f"
fi
echo "  ${INSTALL_PATH} --version"
