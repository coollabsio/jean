import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPreferences } from '@/types/preferences'
import {
  CLIENT_PREFERENCES_CHANGED_EVENT,
  CLIENT_PREFERENCES_STORAGE_KEY,
  clearClientPreferencesForTests,
  defaultClientPreferences,
  readClientPreferences,
  subscribeToClientPreferences,
  splitClientPreferencePatch,
  updateClientPreferences,
} from './client-preferences'

describe('client-preferences', () => {
  let storage = new Map<string, string>()

  beforeEach(() => {
    storage = new Map()
    vi.mocked(window.localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
    vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => {
      storage.set(key, value)
    })
    vi.mocked(window.localStorage.removeItem).mockImplementation(key => {
      storage.delete(key)
    })
    clearClientPreferencesForTests()
  })

  it('returns versioned client defaults without legacy preferences', () => {
    expect(readClientPreferences()).toEqual(defaultClientPreferences())
  })

  it('seeds client-owned values from legacy preferences only once', () => {
    const first = readClientPreferences({
      ...defaultPreferences,
      theme: 'dark',
      editor: 'vscode',
      favorite_models: ['codex:gpt-5.6-sol'],
    })
    const second = readClientPreferences({
      ...defaultPreferences,
      theme: 'light',
      editor: 'zed',
    })

    expect(first.theme).toBe('dark')
    expect(first.editor).toBe('vscode')
    expect(second.theme).toBe('dark')
    expect(second.editor).toBe('vscode')
    expect(first).not.toHaveProperty('favorite_models')
  })

  it('prefers existing client-local zoom over the legacy server value', () => {
    storage.set(
      'jean-client-zoom',
      JSON.stringify({
        zoom_level: 125,
        mobile_zoom_level: 150,
        sync_zoom_levels: false,
      })
    )

    const result = readClientPreferences({
      ...defaultPreferences,
      zoom_level: 90,
      mobile_zoom_level: 90,
      sync_zoom_levels: true,
    })

    expect(result.zoom_level).toBe(125)
    expect(result.mobile_zoom_level).toBe(150)
    expect(result.sync_zoom_levels).toBe(false)
  })

  it('normalizes invalid local values', () => {
    const result = updateClientPreferences({
      zoom_level: 500,
      mobile_zoom_level: 1,
      terminal_font_size: 99,
      ui_font_size: 0,
    })

    expect(result.zoom_level).toBe(200)
    expect(result.mobile_zoom_level).toBe(50)
    expect(result.terminal_font_size).toBe(24)
    expect(result.ui_font_size).toBe(10)
  })

  it('persists partial updates and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToClientPreferences(listener)

    const result = updateClientPreferences({ theme: 'dark' })

    expect(result.theme).toBe('dark')
    expect(listener).toHaveBeenCalledWith(result)
    expect(storage.get(CLIENT_PREFERENCES_STORAGE_KEY)).toContain(
      '"theme":"dark"'
    )
    unsubscribe()
  })

  it('notifies subscribers when another browser context changes storage', () => {
    const listener = vi.fn()
    subscribeToClientPreferences(listener)
    const next = { ...defaultClientPreferences(), theme: 'dark' }
    storage.set(CLIENT_PREFERENCES_STORAGE_KEY, JSON.stringify(next))

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: CLIENT_PREFERENCES_STORAGE_KEY,
        newValue: JSON.stringify(next),
      })
    )

    expect(listener).toHaveBeenCalledWith(next)
    expect(CLIENT_PREFERENCES_CHANGED_EVENT).toBe(
      'jean-client-preferences-changed'
    )
  })

  it('separates client-owned fields from instance-wide fields', () => {
    const [client, server] = splitClientPreferencePatch({
      theme: 'dark',
      editor: 'vscode',
      favorite_models: ['codex:gpt-5.6-sol'],
      default_backend: 'codex',
    })

    expect(client).toEqual({ theme: 'dark', editor: 'vscode' })
    expect(server).toEqual({
      favorite_models: ['codex:gpt-5.6-sol'],
      default_backend: 'codex',
    })
  })
})
