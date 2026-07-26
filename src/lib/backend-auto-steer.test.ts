import { describe, expect, it } from 'vitest'
import {
  isBackendAutoSteerEnabled,
  isSteerCapableBackend,
} from './backend-auto-steer'

describe('isSteerCapableBackend', () => {
  it('returns true for backends that support steering', () => {
    expect(isSteerCapableBackend('codex')).toBe(true)
    expect(isSteerCapableBackend('opencode')).toBe(true)
    expect(isSteerCapableBackend('pi')).toBe(true)
    expect(isSteerCapableBackend('grok')).toBe(true)
  })

  it('returns false for backends without steering', () => {
    expect(isSteerCapableBackend('claude')).toBe(false)
    expect(isSteerCapableBackend('cursor')).toBe(false)
    expect(isSteerCapableBackend('kimi')).toBe(false)
    expect(isSteerCapableBackend(null)).toBe(false)
    expect(isSteerCapableBackend(undefined)).toBe(false)
  })
})

describe('isBackendAutoSteerEnabled', () => {
  it('defaults to true for steer-capable backends', () => {
    expect(isBackendAutoSteerEnabled('codex')).toBe(true)
    expect(isBackendAutoSteerEnabled('opencode')).toBe(true)
    expect(isBackendAutoSteerEnabled('pi')).toBe(true)
    expect(isBackendAutoSteerEnabled('grok')).toBe(true)
  })

  it('returns false when the backend preference is disabled', () => {
    expect(
      isBackendAutoSteerEnabled('codex', { codex_auto_steer_enabled: false })
    ).toBe(false)
    expect(
      isBackendAutoSteerEnabled('opencode', {
        opencode_auto_steer_enabled: false,
      })
    ).toBe(false)
    expect(
      isBackendAutoSteerEnabled('pi', { pi_auto_steer_enabled: false })
    ).toBe(false)
    expect(
      isBackendAutoSteerEnabled('grok', { grok_auto_steer_enabled: false })
    ).toBe(false)
  })

  it('returns false for non-steer backends even when prefs are true', () => {
    expect(
      isBackendAutoSteerEnabled('claude', { codex_auto_steer_enabled: true })
    ).toBe(false)
    expect(
      isBackendAutoSteerEnabled('kimi', { kimi_auto_steer_enabled: true })
    ).toBe(false)
  })
})
