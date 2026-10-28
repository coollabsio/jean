import { afterEach, describe, expect, it } from 'vitest'
import {
  getPreferenceSearchEntries,
  searchPreferenceEntries,
} from './preferences-search'

const nativeOnlyEntryIds = [
  'claude-cli',
  'codex-cli',
  'opencode-cli',
  'cursor-cli',
  'pi-cli',
  'kimi-cli',
  'muse-cli',
  'devin-cli',
  'github-cli',
  'coderabbit-cli',
  'general-troubleshooting',
  'web-access-server',
  'web-access-authentication',
]

const paneSources = import.meta.glob<string>(
  ['./panes/*.tsx', '!./panes/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true }
)

const setTauriInternals = (enabled: boolean) => {
  if (enabled) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: () => undefined },
    })
  } else {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  }
}

describe('preferences search index', () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  })

  it('omits native-only sections in browser builds', () => {
    setTauriInternals(false)

    nativeOnlyEntryIds.forEach(id => {
      expect(getPreferenceSearchEntries().some(entry => entry.id === id)).toBe(
        false
      )
    })

    expect(
      searchPreferenceEntries('application logs').some(
        entry => entry.id === 'general-troubleshooting'
      )
    ).toBe(false)
  })

  it('includes native-only sections in the desktop app', () => {
    setTauriInternals(true)

    nativeOnlyEntryIds.forEach(id => {
      expect(getPreferenceSearchEntries().some(entry => entry.id === id)).toBe(
        true
      )
    })

    expect(
      searchPreferenceEntries('application logs').some(
        entry => entry.id === 'general-troubleshooting'
      )
    ).toBe(true)
  })

  it('finds the server preview hostname in web access', () => {
    setTauriInternals(false)

    expect(
      searchPreferenceEntries('preview hostname').some(
        entry => entry.id === 'general-browser'
      )
    ).toBe(true)
  })

  it('routes backend searches to dedicated backend panes', () => {
    setTauriInternals(true)

    expect(searchPreferenceEntries('claude model')[0]?.pane).toBe('claude')
    expect(searchPreferenceEntries('codex reasoning')[0]?.pane).toBe('codex')
    expect(searchPreferenceEntries('opencode login')[0]?.pane).toBe('opencode')
    expect(searchPreferenceEntries('cursor model')[0]?.pane).toBe('cursor')
    expect(searchPreferenceEntries('pi model')[0]?.pane).toBe('pi')
    expect(searchPreferenceEntries('kimi model')[0]?.pane).toBe('kimi')
    expect(searchPreferenceEntries('muse model')[0]?.pane).toBe('muse')
    expect(searchPreferenceEntries('META_API_KEY')[0]?.pane).toBe('muse')
    expect(searchPreferenceEntries('devin login')[0]?.pane).toBe('devin')
    expect(searchPreferenceEntries('devin beta')[0]?.pane).toBe('devin')
    expect(searchPreferenceEntries('github login')[0]?.pane).toBe('github')
    expect(searchPreferenceEntries('coderabbit login')[0]?.pane).toBe(
      'coderabbit'
    )
  })

  it('routes terminal searches to the dedicated terminal pane', () => {
    setTauriInternals(true)

    expect(searchPreferenceEntries('terminal renderer')[0]?.pane).toBe(
      'terminal'
    )
    expect(searchPreferenceEntries('ghostty web')[0]?.pane).toBe('terminal')
  })

  it('finds chat file-path and spellcheck settings', () => {
    setTauriInternals(false)

    expect(
      searchPreferenceEntries('spellcheck').some(
        entry => entry.id === 'general-chat'
      )
    ).toBe(true)
    expect(
      searchPreferenceEntries('full file paths').some(
        entry => entry.id === 'general-chat'
      )
    ).toBe(true)
  })

  it('returns relevant appearance hits for font queries', () => {
    setTauriInternals(false)
    const results = searchPreferenceEntries('appearance font')

    expect(results.some(entry => entry.id === 'appearance-fonts')).toBe(true)
  })

  it('finds the collapsed sidebar edge setting', () => {
    setTauriInternals(false)

    expect(searchPreferenceEntries('screen edge')[0]?.id).toBe(
      'appearance-sidebar'
    )
  })

  it('indexes every settings section rendered in the panes', () => {
    const renderedAnchors = Object.values(paneSources).flatMap(source =>
      [...source.matchAll(/anchorId="(pref-[a-z0-9-]+)"/g)].map(m => m[1])
    )
    setTauriInternals(true)
    const indexed = new Set(getPreferenceSearchEntries().map(e => e.anchorId))
    setTauriInternals(false)
    getPreferenceSearchEntries().forEach(e => indexed.add(e.anchorId))

    expect(renderedAnchors.length).toBeGreaterThan(0)
    expect(renderedAnchors.filter(anchor => !indexed.has(anchor))).toEqual([])
  })

  it('shows the web access sign-out section only in web access', () => {
    setTauriInternals(false)
    expect(searchPreferenceEntries('sign out')[0]?.id).toBe('general-session')

    setTauriInternals(true)
    expect(
      getPreferenceSearchEntries().some(entry => entry.id === 'general-session')
    ).toBe(false)
  })

  it('finds settings that were missing from the index', () => {
    setTauriInternals(true)

    expect(searchPreferenceEntries('sentry auth token')[0]?.id).toBe(
      'integrations-sentry'
    )
    expect(searchPreferenceEntries('jean mcp')[0]?.id).toBe('mcp-jean')
    expect(searchPreferenceEntries('deepwiki')[0]?.id).toBe('mcp-devin')
    expect(searchPreferenceEntries('bind address')[0]?.id).toBe(
      'web-access-server'
    )
    expect(searchPreferenceEntries('window transparency')[0]?.id).toBe(
      'appearance-theme'
    )
    expect(searchPreferenceEntries('grok model')[0]?.pane).toBe('grok')
    expect(searchPreferenceEntries('command code')[0]?.pane).toBe('commandcode')
  })
})
