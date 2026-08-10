import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  isBackendUsable,
  useBackendAuthStatuses,
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
  'antigravity',
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
vi.mock('@/services/antigravity-cli', () => ({
  useAntigravityCliStatus: () => statusQuery('antigravity'),
  useAntigravityCliAuth: () => authQuery('antigravity'),
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

  it('includes installed backends even when not authenticated (issue #627/#649)', () => {
    status.claude.installed = true
    auth.claude.authenticated = false
    status.codex.installed = true
    auth.codex.authenticated = true

    const { result } = renderHook(() => useInstalledBackends())

    expect(result.current.installedBackends).toEqual(['claude', 'codex'])
    expect(result.current.isLoading).toBe(false)
  })

  it('includes all installed backends regardless of auth', () => {
    status.claude.installed = true
    auth.claude.authenticated = true
    status.opencode.installed = true
    auth.opencode.authenticated = true
    status.cursor.installed = true
    // cursor not authenticated — still listed

    const { result } = renderHook(() => useInstalledBackends())

    expect(result.current.installedBackends).toEqual([
      'claude',
      'opencode',
      'cursor',
    ])
  })

  it('lists installed Antigravity even when not authenticated', () => {
    status.antigravity.installed = true
    auth.antigravity.authenticated = false
    status.claude.installed = true
    auth.claude.authenticated = true

    const { result } = renderHook(() => useInstalledBackends())

    expect(result.current.installedBackends).toEqual(['claude', 'antigravity'])
  })

  it('returns empty when nothing is installed', () => {
    status.claude.installed = false
    const { result } = renderHook(() => useInstalledBackends())
    expect(result.current.installedBackends).toEqual([])
  })
})

describe('useBackendAuthStatuses', () => {
  beforeEach(() => {
    for (const backend of BACKENDS) {
      status[backend].installed = false
      auth[backend].authenticated = false
    }
  })

  it('reports auth only for installed backends', () => {
    status.claude.installed = true
    auth.claude.authenticated = false
    status.opencode.installed = true
    auth.opencode.authenticated = true

    const { result } = renderHook(() => useBackendAuthStatuses())

    expect(result.current.authByBackend.claude).toBe(false)
    expect(result.current.authByBackend.opencode).toBe(true)
    expect(result.current.authByBackend.codex).toBeUndefined()
    expect(result.current.isLoading).toBe(false)
  })

  it('reports Antigravity auth when installed', () => {
    status.antigravity.installed = true
    auth.antigravity.authenticated = true

    const { result } = renderHook(() => useBackendAuthStatuses())

    expect(result.current.authByBackend.antigravity).toBe(true)

    status.antigravity.installed = false
    const { result: uninstalled } = renderHook(() => useBackendAuthStatuses())
    expect(uninstalled.current.authByBackend.antigravity).toBeUndefined()
  })
})
