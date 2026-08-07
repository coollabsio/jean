import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readMainWindowConfig(configPath: string) {
  const rawConfig = readFileSync(join(process.cwd(), configPath), 'utf8')
  const config = JSON.parse(rawConfig) as {
    app?: {
      windows?: { dragDropEnabled?: boolean; transparent?: boolean }[]
    }
  }

  return config.app?.windows?.[0]
}

function readConfig(configPath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(process.cwd(), configPath), 'utf8')
  ) as Record<string, unknown>
}

function mergeJsonConfig(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base }

  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof merged[key] === 'object' &&
      merged[key] !== null &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = mergeJsonConfig(
        merged[key] as Record<string, unknown>,
        value as Record<string, unknown>
      )
    } else if (value === null) {
      Reflect.deleteProperty(merged, key)
    } else {
      merged[key] = value
    }
  }

  return merged
}

describe('Tauri drag/drop configuration', () => {
  it.each(['src-tauri/tauri.conf.json', 'src-tauri/tauri.conf.dev.json'])(
    'disables native webview drag/drop in %s so browser DnD can handle reordering',
    configPath => {
      expect(readMainWindowConfig(configPath)?.dragDropEnabled).toBe(false)
    }
  )
})

describe('Tauri Windows configuration', () => {
  it('preserves the complete main-window configuration when applying the Windows override', () => {
    const resolved = mergeJsonConfig(
      readConfig('src-tauri/tauri.conf.json'),
      readConfig('src-tauri/tauri.windows.conf.json')
    ) as {
      app: { windows: Record<string, unknown>[] }
    }

    expect(resolved.app.windows[0]).toMatchObject({
      title: 'Jean',
      width: 800,
      height: 600,
      minWidth: 1000,
      minHeight: 700,
      center: true,
      decorations: true,
      titleBarStyle: 'Overlay',
      shadow: true,
      dragDropEnabled: false,
      transparent: false,
      windowEffects: {
        effects: [],
        radius: 0,
        state: 'active',
      },
    })
  })

  it('does not enable transparency in the development configuration', () => {
    expect(
      readMainWindowConfig('src-tauri/tauri.conf.dev.json')?.transparent
    ).toBe(false)
  })

  it('starts the production main window opaque (vibrancy is opt-in)', () => {
    const main = readMainWindowConfig('src-tauri/tauri.conf.json') as {
      transparent?: boolean
      windowEffects?: { effects?: unknown[] }
    }
    expect(main?.transparent).toBe(false)
    expect(main?.windowEffects?.effects ?? []).toEqual([])
  })
})
