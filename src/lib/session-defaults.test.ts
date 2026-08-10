import { describe, expect, it } from 'vitest'
import {
  resolveDefaultModelForBackend,
  resolveSelectedModelForBackend,
} from './session-defaults'
import type { AppPreferences } from '@/types/preferences'

const preferences = {
  selected_model: 'claude-sonnet-4-6[1m]',
  selected_codex_model: 'gpt-5.5-fast',
  selected_opencode_model: 'opencode/gpt-5.6-sol',
  selected_cursor_model: 'cursor/auto',
  selected_commandcode_model: 'commandcode/deepseek/deepseek-v4-flash',
  selected_kimi_model: 'kimi/custom-coding-model',
  selected_antigravity_model: 'antigravity/flash',
} as unknown as AppPreferences

describe('resolveDefaultModelForBackend', () => {
  it.each([
    ['claude', 'claude-opus-4-8[1m]'],
    ['codex', 'gpt-5.6-sol'],
    ['opencode', 'opencode/gpt-5.6-sol'],
    ['cursor', 'cursor/auto'],
  ] as const)(
    'falls back to the built-in %s default when no preference exists',
    (backend, expectedModel) => {
      expect(resolveDefaultModelForBackend(backend, {} as AppPreferences)).toBe(
        expectedModel
      )
    }
  )

  it('uses the Command Code model preference for Command Code sessions', () => {
    expect(resolveDefaultModelForBackend('commandcode', preferences)).toBe(
      'commandcode/deepseek/deepseek-v4-flash'
    )
  })

  it('falls back to CLI default when no Command Code model preference exists', () => {
    expect(
      resolveDefaultModelForBackend('commandcode', {} as AppPreferences)
    ).toBe('commandcode/default')
  })

  it('uses the Kimi model preference for Kimi Code sessions', () => {
    expect(resolveDefaultModelForBackend('kimi', preferences)).toBe(
      'kimi/custom-coding-model'
    )
  })

  it('falls back to the Kimi Code configured default model', () => {
    expect(resolveDefaultModelForBackend('kimi', {} as AppPreferences)).toBe(
      'kimi/default'
    )
  })

  it('uses the Antigravity model preference for Antigravity sessions', () => {
    expect(resolveDefaultModelForBackend('antigravity', preferences)).toBe(
      'antigravity/flash'
    )
  })

  it('falls back to the Antigravity CLI automatic model', () => {
    expect(resolveDefaultModelForBackend('antigravity', {} as AppPreferences)).toBe(
      'antigravity/auto'
    )
  })

  it('uses the first available PI provider model when the stored PI default is unavailable', () => {
    expect(
      resolveDefaultModelForBackend(
        'pi',
        { selected_pi_model: 'pi/sonnet' } as unknown as AppPreferences,
        [
          { value: 'pi/openai-codex/gpt-5.5', label: 'GPT 5.5' },
          { value: 'pi/openai-codex/gpt-5.4', label: 'GPT 5.4' },
        ]
      )
    ).toBe('pi/openai-codex/gpt-5.5')
  })

  it('keeps a stored PI model when it is available', () => {
    expect(
      resolveDefaultModelForBackend(
        'pi',
        {
          selected_pi_model: 'pi/openai-codex/gpt-5.4',
        } as unknown as AppPreferences,
        [
          { value: 'pi/openai-codex/gpt-5.5', label: 'GPT 5.5' },
          { value: 'pi/openai-codex/gpt-5.4', label: 'GPT 5.4' },
        ]
      )
    ).toBe('pi/openai-codex/gpt-5.4')
  })
})

describe('resolveSelectedModelForBackend', () => {
  it('replaces a stale Claude session model for a Codex backend', () => {
    expect(
      resolveSelectedModelForBackend(
        'codex',
        'claude-opus-4-8[1m]',
        preferences
      )
    ).toBe('gpt-5.5-fast')
  })

  it('keeps a session model that matches its backend', () => {
    expect(
      resolveSelectedModelForBackend('codex', 'gpt-5.6-sol-fast', preferences)
    ).toBe('gpt-5.6-sol-fast')
  })
})
