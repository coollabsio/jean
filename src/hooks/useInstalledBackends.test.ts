import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  isBackendUsable,
  useInstalledBackends,
} from '@/hooks/useInstalledBackends'
import type { CliBackend } from '@/types/preferences'

const BACKENDS: CliBackend[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'pi',
  'commandcode',
  'grok',
  'kimi',
]

const status = Object.fromEntries(
  BACKENDS.map(backend => [backend, { installed: false }])
) as Record<CliBackend, { installed: boolean }>

const auth = Object.fromEntries(
  BACKENDS.map(backend => [backend, { authenticated: false }])
) as Record<CliBackend, { authenticated: boolean }>

function statusQuery(backend: CliBackend) {
  return {
    data: status[backend],
    isLoading: false,
  }
}

function authQuery(backend: CliBackend) {
  return {
    data: auth[backend],
    isLoading: false,
  }
}

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => statusQuery('claude'),
  useClaudeCliAuth: () => authQuery('claude'),
}))
vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => statusQuery('codex'),
  useCodexCliAuth: () => authQuery('codex'),
}))
vi.mock('@/services/opencode-cli', () => ({
  useOpencodeCliStatus: () => statusQuery('opencode'),
  useOpencodeCliAuth: () => authQuery('opencode'),
}))
vi.mock('@/services/cursor-cli', () => ({
  useCursorCliStatus: () => statusQuery('cursor'),
  useCursorCliAuth: () => authQuery('cursor'),
}))
vi.mock('@/services/pi-cli', () => ({
  usePiCliStatus: () => statusQuery('pi'),
  usePiCliAuth: () => authQuery('pi'),
}))
vi.mock('@/services/commandcode-cli', () => ({
  useCommandCodeCliStatus: () => statusQuery('commandcode'),
  useCommandCodeCliAuth: () => authQuery('commandcode'),
}))
vi.mock('@/services/grok-cli', () => ({
  useGrokCliStatus: () => statusQuery('grok'),
  useGrokCliAuth: () => authQuery('grok'),
}))
vi.mock('@/services/kimi-cli', () => ({
  useKimiCliStatus: () => statusQuery('kimi'),
  useKimiCliAuth: () => authQuery('kimi'),
}))

describe('isBackendUsable', () => {
  it('requires installed; excludes only when auth is known false', () => {
    expect(isBackendUsable(true, true)).toBe(true)
    expect(isBackendUsable(true, false)).toBe(false)
    expect(isBackendUsable(false, true)).toBe(false)
    expect(isBackendUsable(undefined, true)).toBe(false)
    // Auth still loading — keep usable so picker doesn't flash empty
    expect(isBackendUsable(true, undefined)).toBe(true)
  })
})

describe('useInstalledBackends', () => {
  beforeEach(() => {
    for (const backend of BACKENDS) {
      status[backend].installed = false
      auth[backend].authenticated = false
    }
  })

  it('excludes installed backends that are not authenticated', () => {
    status.claude.installed = true
    auth.claude.authenticated = false
    status.codex.installed = true
    auth.codex.authenticated = true

    const { result } = renderHook(() => useInstalledBackends())

    expect(result.current.installedBackends).toEqual(['codex'])
    expect(result.current.isLoading).toBe(false)
  })

  it('includes all backends that are both installed and authenticated', () => {
    status.claude.installed = true
    auth.claude.authenticated = true
    status.opencode.installed = true
    auth.opencode.authenticated = true
    status.cursor.installed = true
    // cursor not authenticated

    const { result } = renderHook(() => useInstalledBackends())

    expect(result.current.installedBackends).toEqual(['claude', 'opencode'])
  })

  it('returns empty when nothing is ready', () => {
    status.claude.installed = true
    // not authenticated
    const { result } = renderHook(() => useInstalledBackends())
    expect(result.current.installedBackends).toEqual([])
  })
})
