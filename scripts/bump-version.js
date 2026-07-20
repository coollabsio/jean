#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const bump = process.argv[2] || 'patch'
const isExplicitVersion = /^\d+\.\d+\.\d+$/.test(bump)
if (!isExplicitVersion && !['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Usage: node scripts/bump-version.js [patch|minor|major|x.y.z]`)
  process.exit(1)
}

// Read current version from package.json
const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)

const newVersion = isExplicitVersion
  ? bump
  : bump === 'major'
    ? `${major + 1}.0.0`
    : bump === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`

// Update package.json
pkg.version = newVersion
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// Update tauri.conf.json
const tauriConfPath = resolve(root, 'src-tauri/tauri.conf.json')
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'))
tauriConf.version = newVersion
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n')

// Update Cargo.toml files (including jean-core so library fallbacks stay aligned)
for (const cargoPath of [
  resolve(root, 'src-tauri/Cargo.toml'),
  resolve(root, 'src-server/Cargo.toml'),
  resolve(root, 'jean-core/Cargo.toml'),
]) {
  let cargo = readFileSync(cargoPath, 'utf-8')
  cargo = cargo.replace(/^version = ".*"/m, `version = "${newVersion}"`)
  writeFileSync(cargoPath, cargo)
}

// Keep Cargo.lock package versions in sync so `cargo build --locked` works in CI.
// Path packages store their own version in the lockfile; bumping only Cargo.toml
// leaves the lock stale (Server Release failed on this for v0.1.68).
// jean-core must stay in lockstep too — server self-update used to read
// jean-core's CARGO_PKG_VERSION and offered updates forever after a release.
for (const [lockPath, packageName] of [
  [resolve(root, 'src-tauri/Cargo.lock'), 'jean'],
  [resolve(root, 'src-tauri/Cargo.lock'), 'jean-core'],
  [resolve(root, 'src-server/Cargo.lock'), 'jean-server'],
  [resolve(root, 'src-server/Cargo.lock'), 'jean-core'],
  [resolve(root, 'jean-core/Cargo.lock'), 'jean-core'],
]) {
  let lock
  try {
    lock = readFileSync(lockPath, 'utf-8')
  } catch {
    continue
  }
  const pattern = new RegExp(
    `(name = "${packageName}"\\nversion = ")[^"]+(")`
  )
  if (!pattern.test(lock)) {
    console.warn(
      `Warning: package ${packageName} not found in ${lockPath}; skip lock bump`
    )
    continue
  }
  writeFileSync(lockPath, lock.replace(pattern, `$1${newVersion}$2`))
}

console.log(
  `Bumped version: ${pkg.version.replace(newVersion, '')}${major}.${minor}.${patch} → ${newVersion}`
)
