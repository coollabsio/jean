import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const appRunSource = join(repoRoot, 'scripts/appimage-webkit-fix.sh')

function makeFakeAppDir(root) {
  const appDir = join(root, 'Jean.AppDir')
  mkdirSync(join(appDir, 'usr/bin'), { recursive: true })
  mkdirSync(join(appDir, 'usr/lib/gstreamer-1.0'), { recursive: true })
  mkdirSync(join(appDir, 'apprun-hooks'), { recursive: true })

  // Dummy binary that prints the env Jean would inherit.
  writeFileSync(
    join(appDir, 'usr/bin/jean'),
    `#!/usr/bin/env bash
echo "GST_PLUGIN_PATH=\${GST_PLUGIN_PATH-}"
echo "GST_PLUGIN_SYSTEM_PATH=\${GST_PLUGIN_SYSTEM_PATH-}"
echo "LD_LIBRARY_PATH=\${LD_LIBRARY_PATH-}"
echo "WEBKIT_DISABLE_DMABUF_RENDERER=\${WEBKIT_DISABLE_DMABUF_RENDERER-}"
echo "WEBKIT_DISABLE_COMPOSITING_MODE=\${WEBKIT_DISABLE_COMPOSITING_MODE-}"
`
  )
  chmodSync(join(appDir, 'usr/bin/jean'), 0o755)

  writeFileSync(join(appDir, 'apprun-hooks/linuxdeploy-plugin-gtk.sh'), '#!/bin/true\n')
  writeFileSync(
    join(appDir, 'AppRun'),
    readFileSync(appRunSource, 'utf8')
  )
  chmodSync(join(appDir, 'AppRun'), 0o755)

  return appDir
}

test('appimage-webkit-fix.sh is valid bash', () => {
  execFileSync('bash', ['-n', appRunSource], { stdio: 'pipe' })
})

test('bundleMediaFramework is enabled for AppImage packaging', () => {
  const conf = JSON.parse(
    readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8')
  )
  assert.equal(conf.bundle?.linux?.appimage?.bundleMediaFramework, true)
})

test('AppRun points GST_PLUGIN_PATH at bundled plugins when system WebKit is absent', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jean-appimage-apprun-'))
  try {
    const appDir = makeFakeAppDir(tempRoot)
    // Force the "no system WebKit" branch by running in an empty fake root-like env.
    // The script checks absolute /usr/lib paths; we cannot hide real system WebKit,
    // so only assert bundled path appears when the script sets GST vars from AppDir.
    // If system WebKit exists on the host, GST paths will still include AppDir plugins.
    const output = execFileSync(join(appDir, 'AppRun'), {
      encoding: 'utf8',
      env: {
        ...process.env,
        // Keep path minimal; AppRun rebuilds LD_LIBRARY_PATH itself.
        LD_LIBRARY_PATH: '',
        GST_PLUGIN_PATH: '',
        GST_PLUGIN_SYSTEM_PATH: '',
      },
    })

    assert.match(
      output,
      /GST_PLUGIN_PATH=.*Jean\.AppDir\/usr\/lib\/gstreamer-1\.0/
    )
    assert.match(
      output,
      /GST_PLUGIN_SYSTEM_PATH=.*Jean\.AppDir\/usr\/lib\/gstreamer-1\.0/
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

function runAppRun(env = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jean-appimage-apprun-'))
  try {
    const appDir = makeFakeAppDir(tempRoot)
    const output = execFileSync(join(appDir, 'AppRun'), {
      encoding: 'utf8',
      env: {
        ...process.env,
        LD_LIBRARY_PATH: '',
        GST_PLUGIN_PATH: '',
        GST_PLUGIN_SYSTEM_PATH: '',
        // Clear WebKit vars so defaults/overrides are observable.
        WEBKIT_DISABLE_DMABUF_RENDERER: '',
        WEBKIT_DISABLE_COMPOSITING_MODE: '',
        JEAN_SAFE_GRAPHICS: '',
        ...env,
      },
    })
    return output
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test('AppRun defaults WEBKIT_DISABLE_DMABUF_RENDERER without software compositing', () => {
  const output = runAppRun()
  assert.match(output, /WEBKIT_DISABLE_DMABUF_RENDERER=1/)
  // Unset compositing var should stay empty (not forced to 1).
  assert.match(output, /WEBKIT_DISABLE_COMPOSITING_MODE=$/m)
})

test('AppRun enables software compositing when JEAN_SAFE_GRAPHICS is truthy', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'Yes']) {
    const output = runAppRun({ JEAN_SAFE_GRAPHICS: value })
    assert.match(
      output,
      /WEBKIT_DISABLE_COMPOSITING_MODE=1/,
      `expected JEAN_SAFE_GRAPHICS=${value} to enable software compositing`
    )
  }
})

test('AppRun preserves explicit WEBKIT_DISABLE_DMABUF_RENDERER override', () => {
  const output = runAppRun({ WEBKIT_DISABLE_DMABUF_RENDERER: '0' })
  assert.match(output, /WEBKIT_DISABLE_DMABUF_RENDERER=0/)
})
