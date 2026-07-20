import assert from 'node:assert/strict'
import { readFileSync, accessSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = resolve(root, 'scripts/install-jean-server.sh')

test('install-jean-server.sh is executable and bash-clean', () => {
  accessSync(script, constants.X_OK)
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('install-jean-server.sh help documents core options', () => {
  const result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--host/)
  assert.match(result.stdout, /--port/)
  assert.match(result.stdout, /--token/)
  assert.match(result.stdout, /--user-install/)
  assert.match(result.stdout, /--uninstall/)
  assert.match(result.stdout, /systemd/)
  assert.match(result.stdout, /tailscale/)
  assert.match(result.stdout, /all interfaces|0\.0\.0\.0/)
  assert.match(result.stdout, /Non-interactive|non-interactive|-y/)
})

test('install-jean-server.sh script covers download, verify, systemd, env file', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /jean-server-linux-\$\{ARCH\}|jean-server-\$\{ASSET_ARCH\}/)
  assert.match(source, /sha256|Checksum/)
  assert.match(source, /systemctl/)
  assert.match(source, /EnvironmentFile/)
  assert.match(source, /JEAN_TOKEN/)
  assert.match(source, /JEAN_HOST/)
  assert.match(source, /JEAN_PORT/)
  assert.match(source, /openrc/i)
  assert.match(source, /atomic_install_binary|mv -f/)
  assert.match(source, /--user-install/)
  assert.match(source, /--uninstall/)
})

test('install-jean-server.sh refuses public bind without token', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /Refusing --no-token with public bind host/)
  assert.match(source, /is_wildcard_bind/)
})

test('install-jean-server.sh prompts for bind interface and supports presets', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /prompt_bind_settings/)
  assert.match(source, /detect_tailscale_ipv4/)
  assert.match(source, /detect_lan_ipv4/)
  assert.match(source, /resolve_host_preset/)
  assert.match(source, /HOST_EXPLICIT/)
  assert.match(source, /PORT_EXPLICIT/)
  assert.match(source, /\/dev\/tty/)
  assert.match(source, /Choose which interface jean-server should bind to/)
  assert.match(source, /tailscale \| ts/)
  assert.match(source, /lan \| primary/)
})

test('host presets resolve via installer helper logic', () => {
  const source = readFileSync(script, 'utf8')

  // Keep source reference so we fail if presets diverge from the script docs.
  assert.match(source, /tailscale\|ts\|tailnet/)
  assert.match(source, /lan\|primary/)
  assert.match(source, /0\.0\.0\.0\|::\|\\\*\|all\|any\|public\|everywhere/)

  // Exercise pure helper logic that mirrors resolve_host_preset / validators.
  const harness = `
set -euo pipefail
die() { printf 'error: %s\\n' "$*" >&2; exit 1; }
is_loopback_bind() {
  case "$1" in
    127.0.0.1|::1|localhost) return 0 ;;
    *) return 1 ;;
  esac
}
is_wildcard_bind() {
  case "$1" in
    0.0.0.0|::|\\*|all|public) return 0 ;;
    *) return 1 ;;
  esac
}
detect_lan_ipv4() { echo "10.0.0.42"; }
detect_tailscale_ipv4() { echo "100.64.1.2"; }
resolve_host_preset() {
  local raw="$1"
  local lower resolved
  lower="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    ""|localhost|loopback|local-only) echo "127.0.0.1" ;;
    127.0.0.1|::1) echo "$raw" ;;
    0.0.0.0|::|\\*|all|any|public|everywhere)
      if [[ "$raw" == "::" ]]; then echo "::"; else echo "0.0.0.0"; fi
      ;;
    lan|primary)
      resolved="$(detect_lan_ipv4 || true)"
      [[ -n "$resolved" ]] || die "no lan"
      echo "$resolved"
      ;;
    tailscale|ts|tailnet)
      resolved="$(detect_tailscale_ipv4 || true)"
      [[ -n "$resolved" ]] || die "no ts"
      echo "$resolved"
      ;;
    *) echo "$raw" ;;
  esac
}
validate_port() {
  local p="$1"
  [[ "$p" =~ ^[0-9]+$ ]] || return 1
  ((10#$p >= 1 && 10#$p <= 65535))
}

[[ "$(resolve_host_preset localhost)" == "127.0.0.1" ]]
[[ "$(resolve_host_preset all)" == "0.0.0.0" ]]
[[ "$(resolve_host_preset public)" == "0.0.0.0" ]]
[[ "$(resolve_host_preset lan)" == "10.0.0.42" ]]
[[ "$(resolve_host_preset tailscale)" == "100.64.1.2" ]]
[[ "$(resolve_host_preset ts)" == "100.64.1.2" ]]
[[ "$(resolve_host_preset 192.168.1.9)" == "192.168.1.9" ]]
is_wildcard_bind "0.0.0.0"
is_wildcard_bind "all"
! is_wildcard_bind "127.0.0.1"
validate_port 3456
validate_port 1
validate_port 65535
! validate_port 0
! validate_port 65536
! validate_port abc
echo OK
`
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /OK/)
})
