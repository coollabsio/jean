import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildInstallPlan,
  getLinuxBuildDependenciesError,
  shouldStartBackground,
} from './install-local-server.mjs'

test('buildInstallPlan uses the local server defaults', () => {
  const plan = buildInstallPlan({ env: {} })

  assert.deepEqual(plan.buildCommands, [
    ['bun', ['run', 'build']],
    [
      'cargo',
      ['build', '--release', '--manifest-path', 'src-server/Cargo.toml'],
    ],
  ])
  assert.match(plan.builtBinary, /src-server\/target\/release\/jean-server$/)
  assert.equal(plan.installPath, '/usr/local/bin/jean-server')
  assert.equal(plan.service, 'jean-server.service')
})

test('buildInstallPlan supports an explicit binary and service', () => {
  const plan = buildInstallPlan({
    env: {
      JEAN_SERVER_INSTALL_PATH: '/opt/jean/jean-server-dev',
      JEAN_SERVER_SERVICE: 'jean-dev.service',
    },
  })

  assert.equal(plan.installPath, '/opt/jean/jean-server-dev')
  assert.equal(plan.service, 'jean-dev.service')
})

test('shouldStartBackground stays foreground for explicit foreground or the child process', () => {
  assert.equal(shouldStartBackground([]), true)
  assert.equal(shouldStartBackground(['--foreground']), false)
  assert.equal(shouldStartBackground(['--install-child']), false)
})

test('getLinuxBuildDependenciesError explains how to install missing packages', () => {
  const error = getLinuxBuildDependenciesError({
    spawnSyncImpl: () => ({ status: 1 }),
  })

  assert.match(error, /libwebkit2gtk-4\.1-dev/)
  assert.match(error, /libayatana-appindicator3-dev/)
  assert.match(error, /libssl-dev/)
})

test('getLinuxBuildDependenciesError accepts installed packages', () => {
  const error = getLinuxBuildDependenciesError({
    spawnSyncImpl: () => ({ status: 0 }),
  })

  assert.equal(error, null)
})
