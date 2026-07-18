import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(path, 'utf8')

test('server release workflow builds binaries and publishes docker image', () => {
  const workflow = read('.github/workflows/server-release.yml')

  assert.doesNotMatch(workflow, /workflow_id: 'ci-build\.yml'/)
  assert.match(workflow, /needs: metadata/)
  assert.match(workflow, /cd src-server && cargo build --release/)
  assert.match(workflow, /jean-server-linux-amd64/)
  assert.match(workflow, /jean-server-linux-arm64/)
  assert.match(workflow, /docker\/build-push-action@v6/)
  assert.match(workflow, /ghcr\.io/)
})

test('native release workflow does not require a previous CI build', () => {
  const workflow = read('.github/workflows/release.yml')

  assert.doesNotMatch(workflow, /workflow_id: 'ci-build\.yml'/)
  assert.match(workflow, /needs: prepare-release/)
})

test('Dockerfile builds and runs jean-server headlessly as non-root user', () => {
  const dockerfile = read('Dockerfile.server')

  assert.match(dockerfile, /bun run build/)
  assert.match(dockerfile, /COPY src-server \.\/src-server/)
  assert.match(dockerfile, /COPY jean-core \.\/jean-core/)
  assert.match(
    dockerfile,
    /cd src-server && RUSTC_WRAPPER= cargo build --release/
  )
  assert.match(dockerfile, /USER jean/)
  assert.match(dockerfile, /chown -R jean:jean \/home\/jean/)
  assert.match(dockerfile, /JEAN_HOST=0\.0\.0\.0/)
  assert.doesNotMatch(dockerfile, /webkit|gtk|appindicator|xvfb|xauth/i)
  assert.match(dockerfile, /jean-server-entrypoint/)
  assert.match(
    dockerfile,
    /ENTRYPOINT \["\/usr\/local\/bin\/jean-server-entrypoint"\]/
  )
})

test('jean-server depends only on the Tauri-free shared core', () => {
  const cargoToml = read('src-tauri/Cargo.toml')
  const coreCargoToml = read('jean-core/Cargo.toml')
  const serverCargoToml = read('src-server/Cargo.toml')

  assert.doesNotMatch(cargoToml, /jean-server/)
  assert.match(cargoToml, /jean-core = \{ path = "\.\.\/jean-core" \}/)
  assert.match(serverCargoToml, /name = "jean-server"/)
  assert.match(serverCargoToml, /jean-core = \{ path = "\.\.\/jean-core" \}/)
  assert.doesNotMatch(serverCargoToml, /src-tauri|tauri/i)
  assert.doesNotMatch(coreCargoToml, /tauri|wry|webkit|gtk/i)
})

test('Docker entrypoint starts jean-server directly without a display server', () => {
  const entrypoint = read('scripts/docker-entrypoint.sh')

  assert.doesNotMatch(entrypoint, /Xvfb|DISPLAY|WAYLAND|sleep/i)
  assert.match(entrypoint, /exec jean-server "\$@"/)
})

test('shared dispatcher is owned by jean-core and used by the desktop adapter', () => {
  const commandPattern = /^\s*"([a-zA-Z0-9_:-]+)"\s*=>/gm
  const commands = source =>
    [...source.matchAll(commandPattern)].map(match => match[1]).sort()

  const coreCommands = commands(read('jean-core/src/http_server/dispatch.rs'))
  const desktopAdapter = read('src-tauri/src/lib.rs')
  const frontendTransport = read('src/lib/transport.ts')

  assert.ok(coreCommands.length >= 380)
  assert.match(desktopAdapter, /dispatch_core_command/)
  assert.match(frontendTransport, /dispatch_core_command/)
  assert.equal(existsSync('src-tauri/src/http_server/dispatch.rs'), false)
  assert.equal(existsSync('src-tauri/src/chat'), false)
  assert.equal(existsSync('src-tauri/src/projects'), false)
})
