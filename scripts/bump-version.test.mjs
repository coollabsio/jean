import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('bump-version updates the desktop and jean-server versions', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jean-bump-version-'))

  try {
    mkdirSync(join(tempRoot, 'scripts'))
    mkdirSync(join(tempRoot, 'src-tauri'))
    mkdirSync(join(tempRoot, 'src-server'))
    mkdirSync(join(tempRoot, 'jean-core'))

    cpSync('scripts/bump-version.js', join(tempRoot, 'scripts/bump-version.js'))
    writeFileSync(
      join(tempRoot, 'package.json'),
      JSON.stringify(
        { name: 'jean', version: '1.2.3', type: 'module' },
        null,
        2
      ) + '\n'
    )
    writeFileSync(
      join(tempRoot, 'src-tauri/tauri.conf.json'),
      JSON.stringify({ version: '1.2.3' }, null, 2) + '\n'
    )
    writeFileSync(
      join(tempRoot, 'src-tauri/Cargo.toml'),
      '[package]\nname = "jean"\nversion = "1.2.3"\n'
    )
    writeFileSync(
      join(tempRoot, 'src-server/Cargo.toml'),
      '[package]\nname = "jean-server"\nversion = "1.2.3"\n'
    )
    writeFileSync(
      join(tempRoot, 'jean-core/Cargo.toml'),
      '[package]\nname = "jean-core"\nversion = "1.2.3"\n'
    )
    writeFileSync(
      join(tempRoot, 'src-tauri/Cargo.lock'),
      '[[package]]\nname = "jean"\nversion = "1.2.3"\n\n[[package]]\nname = "jean-core"\nversion = "1.2.3"\n'
    )
    writeFileSync(
      join(tempRoot, 'src-server/Cargo.lock'),
      '[[package]]\nname = "jean-server"\nversion = "1.2.3"\n\n[[package]]\nname = "jean-core"\nversion = "1.2.3"\n'
    )
    writeFileSync(
      join(tempRoot, 'jean-core/Cargo.lock'),
      '[[package]]\nname = "jean-core"\nversion = "1.2.3"\n'
    )

    execFileSync('node', ['scripts/bump-version.js', '1.2.4'], {
      cwd: tempRoot,
    })

    assert.equal(readJson(join(tempRoot, 'package.json')).version, '1.2.4')
    assert.equal(
      readJson(join(tempRoot, 'src-tauri/tauri.conf.json')).version,
      '1.2.4'
    )
    assert.match(
      readFileSync(join(tempRoot, 'src-tauri/Cargo.toml'), 'utf8'),
      /^version = "1\.2\.4"/m
    )
    assert.match(
      readFileSync(join(tempRoot, 'src-server/Cargo.toml'), 'utf8'),
      /^version = "1\.2\.4"/m
    )
    assert.match(
      readFileSync(join(tempRoot, 'jean-core/Cargo.toml'), 'utf8'),
      /^version = "1\.2\.4"/m
    )
    assert.match(
      readFileSync(join(tempRoot, 'src-tauri/Cargo.lock'), 'utf8'),
      /name = "jean"\nversion = "1\.2\.4"/
    )
    assert.match(
      readFileSync(join(tempRoot, 'src-tauri/Cargo.lock'), 'utf8'),
      /name = "jean-core"\nversion = "1\.2\.4"/
    )
    assert.match(
      readFileSync(join(tempRoot, 'src-server/Cargo.lock'), 'utf8'),
      /name = "jean-server"\nversion = "1\.2\.4"/
    )
    assert.match(
      readFileSync(join(tempRoot, 'src-server/Cargo.lock'), 'utf8'),
      /name = "jean-core"\nversion = "1\.2\.4"/
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
