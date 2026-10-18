import { describe, expect, it } from 'vitest'
import {
  connectorSectionNote,
  connectorSelected,
  connectorStatus,
  connectorStatusLabel,
  jeanToolSelected,
  hasOwnMcpDiscovery,
  mcpSessionSupport,
  sameConnectors,
  sameJeanTools,
  toggleConnector,
  toggleJeanTool,
} from './agent-connectors'

const alpha = { backend: 'claude', name: 'alpha' }
const beta = { backend: 'claude', name: 'beta' }

describe('mcp session support', () => {
  it('treats only Claude and Grok as per-session', () => {
    expect(mcpSessionSupport('claude')).toBe('per-session')
    expect(mcpSessionSupport('grok')).toBe('per-session')
    expect(mcpSessionSupport('')).toBe('unknown')
    for (const backend of [
      'codex',
      'cursor',
      'opencode',
      'pi',
      'commandcode',
      'kimi',
      'antigravity',
    ]) {
      expect(mcpSessionSupport(backend)).toBe('unsupported')
    }
  })

  it('does not treat Pi or Command Code as having their own server list', () => {
    expect(hasOwnMcpDiscovery('claude')).toBe(true)
    expect(hasOwnMcpDiscovery('codex')).toBe(true)
    expect(hasOwnMcpDiscovery('pi')).toBe(false)
    expect(hasOwnMcpDiscovery('commandcode')).toBe(false)
    expect(hasOwnMcpDiscovery('')).toBe(false)
  })
})

describe('connector allowlist toggles', () => {
  it('starts from no selection and keeps an empty list distinct from unset', () => {
    expect(connectorSelected(null, alpha)).toBe(false)
    expect(toggleConnector(null, alpha, false)).toBeNull()
    expect(toggleConnector(null, alpha, true)).toEqual([alpha])
    expect(toggleConnector([alpha], alpha, false)).toEqual([])
    expect(sameConnectors(null, [])).toBe(false)
    expect(sameConnectors([beta, alpha], [alpha, beta])).toBe(true)
  })

  it('replaces a server instead of duplicating it', () => {
    expect(toggleConnector([alpha], alpha, true)).toEqual([alpha])
    expect(connectorSelected([alpha, beta], beta)).toBe(true)
  })
})

describe('connector status', () => {
  it('reports unsupported, sign-in, default, enabled, and off', () => {
    expect(
      connectorStatus({
        support: 'unsupported',
        limited: true,
        selected: true,
        health: 'connected',
      })
    ).toBe('unsupported')
    expect(
      connectorStatus({
        support: 'per-session',
        limited: true,
        selected: true,
        health: 'needsAuthentication',
      })
    ).toBe('needs-sign-in')
    expect(
      connectorStatus({
        support: 'per-session',
        limited: false,
        selected: false,
      })
    ).toBe('default')
    expect(
      connectorStatus({
        support: 'per-session',
        limited: true,
        selected: true,
        health: 'connected',
      })
    ).toBe('enabled')
    expect(
      connectorStatus({
        support: 'unknown',
        limited: true,
        selected: false,
      })
    ).toBe('off')
    expect(connectorStatusLabel('needs-sign-in')).toBe('Needs sign-in')
    expect(connectorStatusLabel('unsupported')).toBe(
      'Unsupported on this backend'
    )
  })

  it('says an unsupported backend will not apply the switches', () => {
    expect(connectorSectionNote('unsupported', 'codex')).toContain(
      'not applied'
    )
    expect(connectorSectionNote('per-session', 'claude')).toContain('Jean MCP')
    expect(connectorSectionNote('unknown', '')).toContain('Claude or Grok')
    expect(
      connectorSectionNote('unsupported', 'cursor', 'Shared approval.')
    ).toContain('Shared approval.')
  })
})

describe('Jean tool allowlist', () => {
  const catalog = ['delete_worktree', 'notify_user', 'task_list']

  it('treats an unset list as every tool and clears it when all are selected', () => {
    expect(jeanToolSelected(null, 'notify_user')).toBe(true)
    expect(toggleJeanTool(null, 'notify_user', catalog, true)).toBeNull()
    expect(toggleJeanTool(null, 'delete_worktree', catalog, false)).toEqual([
      'notify_user',
      'task_list',
    ])
    expect(
      toggleJeanTool(
        ['notify_user', 'task_list'],
        'delete_worktree',
        catalog,
        true
      )
    ).toBeNull()
    expect(jeanToolSelected(['notify_user'], 'delete_worktree')).toBe(false)
    expect(sameJeanTools(['b', 'a'], ['a', 'b'])).toBe(true)
    expect(sameJeanTools(null, [])).toBe(false)
  })
})
