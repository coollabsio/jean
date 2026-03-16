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

// Update Cargo.toml
const cargoPath = resolve(root, 'src-tauri/Cargo.toml')
let cargo = readFileSync(cargoPath, 'utf-8')
cargo = cargo.replace(/^version = ".*"/m, `version = "${newVersion}"`)
writeFileSync(cargoPath, cargo)

console.log(
  `Bumped version: ${pkg.version.replace(newVersion, '')}${major}.${minor}.${patch} → ${newVersion}`
)
