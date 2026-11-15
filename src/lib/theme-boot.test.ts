import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_COLOUR_TOKENS,
  applyThemeColours,
  type ThemeColours,
} from './custom-themes'
import { CLIENT_PREFERENCES_STORAGE_KEY } from './client-preferences'

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
const bootScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

// The shared test setup stubs localStorage, so back it with a real map here.
const storage = new Map<string, string>()

function runBootScript(theme: 'light' | 'dark', stored: unknown) {
  const root = document.documentElement
  root.removeAttribute('style')
  root.className = ''
  storage.set('ui-theme', theme)
  storage.set(CLIENT_PREFERENCES_STORAGE_KEY, JSON.stringify(stored))
  new Function(bootScript)()
  return root.style
}

function inlineProperties(style: CSSStyleDeclaration) {
  const properties: Record<string, string> = {}
  for (const name of Array.from(style)) {
    if (name.startsWith('--')) properties[name] = style.getPropertyValue(name)
  }
  return properties
}

// Every token gets a distinct colour, so a token missing from the boot
// script's list shows up as a difference.
const everyToken = Object.fromEntries(
  THEME_COLOUR_TOKENS.map((token, i) => [
    token,
    `#${(i + 1).toString(16).padStart(6, '0')}`,
  ])
) as ThemeColours

describe('index.html theme boot script', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
  })

  afterEach(() => {
    storage.clear()
    vi.mocked(localStorage.getItem).mockReset()
    document.documentElement.removeAttribute('style')
    document.documentElement.className = ''
  })

  it.each(['light', 'dark'] as const)(
    'sets the same %s tokens as applyThemeColours',
    mode => {
      const theme = { id: 't', name: 'T', [mode]: everyToken }
      const booted = runBootScript(mode, {
        custom_themes: [theme],
        custom_theme: 't',
      })

      const { style } = document.createElement('div')
      applyThemeColours(style, everyToken)
      expect(inlineProperties(booted)).toEqual(inlineProperties(style))
      expect(Object.keys(inlineProperties(booted))).toHaveLength(
        THEME_COLOUR_TOKENS.length
      )
    }
  )

  it('leaves the built-in colours when no theme matches the mode', () => {
    const theme = { id: 't', name: 'T', dark: { background: '#000000' } }
    const stored = { custom_themes: [theme], custom_theme: 't' }

    expect(inlineProperties(runBootScript('light', stored))).toEqual({})
    expect(
      inlineProperties(runBootScript('dark', { ...stored, custom_theme: null }))
    ).toEqual({})
  })

  it('ignores tokens that are not theme colours', () => {
    const theme = {
      id: 't',
      name: 'T',
      dark: { background: '#000000', 'app-zoom': '3', radius: '0' },
    }
    const style = runBootScript('dark', {
      custom_themes: [theme],
      custom_theme: 't',
    })

    expect(inlineProperties(style)).toEqual({ '--background': '#000000' })
  })

  it('survives malformed stored preferences', () => {
    storage.set('ui-theme', 'dark')
    storage.set(CLIENT_PREFERENCES_STORAGE_KEY, '{not json')
    expect(() => new Function(bootScript)()).not.toThrow()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
