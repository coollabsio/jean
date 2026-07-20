#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const logPath = resolve(root, 'tmp/install-local-server.log')
const childFlag = '--install-child'

export function buildInstallPlan({ env = process.env } = {}) {
  return {
    buildCommands: [
      ['bun', ['run', 'build']],
      [
        'cargo',
        ['build', '--release', '--manifest-path', 'src-server/Cargo.toml'],
      ],
    ],
    builtBinary: resolve(root, 'src-server/target/release/jean-server'),
    installPath: env.JEAN_SERVER_INSTALL_PATH ?? '/usr/local/bin/jean-server',
    service: env.JEAN_SERVER_SERVICE ?? 'jean-server.service',
  }
}

export function shouldStartBackground(args) {
  return !args.includes('--foreground') && !args.includes(childFlag)
}

export function getLinuxBuildDependenciesError({
  spawnSyncImpl = spawnSync,
} = {}) {
  const result = spawnSyncImpl(
    'pkg-config',
    ['--exists', 'glib-2.0', 'webkit2gtk-4.1', 'openssl'],
    { stdio: 'ignore' }
  )
  if (result.status === 0) return null

  return `Missing Linux build dependencies. On Ubuntu, run:
sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf xdg-utils`
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })

  if (result.status !== 0) {
    const details = result.stderr || result.stdout || ''
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${details}`)
  }

  return result.stdout ?? ''
}

function startBackground(args) {
  mkdirSync(dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'a')
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), childFlag, ...args],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    }
  )
  child.unref()
  console.log(`Installing jean-server in the background. Log: ${logPath}`)
}

function usage() {
  console.log(`Usage: bun run install:local:server [-- --foreground]

Builds the frontend and jean-server release binary, atomically replaces the
local server binary, and asks systemd to restart jean-server.service.

Options:
  --foreground  Run in this terminal instead of detaching

Environment:
  JEAN_SERVER_INSTALL_PATH  Binary to replace (default: /usr/local/bin/jean-server)
  JEAN_SERVER_SERVICE       systemd unit to restart (default: jean-server.service)
`)
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('This installer only works on Linux.')
  }

  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage()
    return
  }

  if (shouldStartBackground(args)) {
    startBackground(args.filter(arg => arg !== childFlag))
    return
  }

  const plan = buildInstallPlan()
  console.log(`Writing progress to ${logPath}`)

  const dependencyError = getLinuxBuildDependenciesError()
  if (dependencyError) {
    throw new Error(dependencyError)
  }

  const loadState = run(
    'systemctl',
    ['show', '--property=LoadState', '--value', plan.service],
    { capture: true }
  ).trim()
  if (loadState !== 'loaded') {
    throw new Error(`systemd service is not loaded: ${plan.service}`)
  }
  if (!existsSync(plan.installPath)) {
    throw new Error(`Installed jean-server not found: ${plan.installPath}`)
  }

  for (const [command, commandArgs] of plan.buildCommands) {
    run(command, commandArgs)
  }
  if (!existsSync(plan.builtBinary)) {
    throw new Error(`Built jean-server not found: ${plan.builtBinary}`)
  }

  const temporaryPath = `${plan.installPath}.new-${process.pid}`
  mkdirSync(dirname(plan.installPath), { recursive: true })
  try {
    copyFileSync(plan.builtBinary, temporaryPath)
    chmodSync(temporaryPath, 0o755)
    renameSync(temporaryPath, plan.installPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }

  run('systemctl', ['restart', '--no-block', plan.service])
  console.log(
    `Installed ${plan.installPath} and queued restart of ${plan.service}.`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
