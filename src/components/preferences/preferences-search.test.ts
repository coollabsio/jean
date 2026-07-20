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
  'github-cli',
  'coderabbit-cli',
  'general-troubleshooting',
  'web-access-server',
  'web-access-authentication',
]

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

  it('routes backend searches to dedicated backend panes', () => {
    setTauriInternals(true)

    expect(searchPreferenceEntries('claude model')[0]?.pane).toBe('claude')
    expect(searchPreferenceEntries('codex reasoning')[0]?.pane).toBe('codex')
    expect(searchPreferenceEntries('opencode login')[0]?.pane).toBe('opencode')
    expect(searchPreferenceEntries('cursor model')[0]?.pane).toBe('cursor')
    expect(searchPreferenceEntries('pi model')[0]?.pane).toBe('pi')
    expect(searchPreferenceEntries('kimi model')[0]?.pane).toBe('kimi')
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

  it('returns relevant appearance hits for font queries', () => {
    setTauriInternals(false)
    const results = searchPreferenceEntries('appearance font')

    expect(results.some(entry => entry.id === 'appearance-fonts')).toBe(true)
  })
})
