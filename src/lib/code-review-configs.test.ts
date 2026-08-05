import { describe, expect, it } from 'vitest'
import {
  codeReviewConfigKey,
  getCodeReviewSessionName,
  resolveCodeReviewConfigs,
  resolveCodeReviewFixMode,
  startCodeReviewsSequentially,
} from './code-review-configs'

describe('code review configurations', () => {
  it('waits for each review job to start before starting the next one', async () => {
    const configs = [
      { backend: 'codex', model: 'gpt-5.6-sol' as const },
      { backend: 'claude', model: 'claude-fable-5' as const },
    ]
    let releaseFirst: (() => void) | undefined
    const firstStarted = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const started: string[] = []

    const result = startCodeReviewsSequentially(configs, async config => {
      started.push(config.backend)
      if (config.backend === 'codex') await firstStarted
    })

    await Promise.resolve()
    expect(started).toEqual(['codex'])

    releaseFirst?.()
    await result
    expect(started).toEqual(['codex', 'claude'])
  })

  it('starts remaining review jobs after one fails and aggregates errors', async () => {
    const configs = ['codex', 'claude', 'pi']
    const started: string[] = []
    const codexError = new Error('Codex is unavailable')
    const piError = new Error('Pi is unavailable')

    const result = startCodeReviewsSequentially(configs, async backend => {
      started.push(backend)
      if (backend === 'codex') throw codexError
      if (backend === 'pi') throw piError
    })

    await expect(result).rejects.toMatchObject({
      errors: [codexError, piError],
    })
    expect(started).toEqual(configs)
  })

  it('uses up to five unique configured backend and model pairs', () => {
    expect(
      resolveCodeReviewConfigs({
        configured: [
          { backend: 'codex', model: 'gpt-5.6-sol' },
          { backend: 'claude', model: 'claude-opus-4-8[1m]' },
          { backend: 'codex', model: 'gpt-5.6-sol' },
          { backend: 'cursor', model: 'cursor/auto' },
          { backend: 'pi', model: 'pi/default' },
          { backend: 'grok', model: 'grok/fast' },
          { backend: 'opencode', model: 'opencode/model' },
        ],
        fallbackBackend: 'claude',
        fallbackModel: 'sonnet',
      })
    ).toEqual([
      { backend: 'codex', model: 'gpt-5.6-sol' },
      { backend: 'claude', model: 'claude-opus-4-8[1m]' },
      { backend: 'cursor', model: 'cursor/auto' },
      { backend: 'pi', model: 'pi/default' },
      { backend: 'grok', model: 'grok/fast' },
    ])
  })

  it('falls back to the existing single code review selection', () => {
    expect(
      resolveCodeReviewConfigs({
        configured: [],
        fallbackBackend: 'claude',
        fallbackModel: 'claude-sonnet-5',
      })
    ).toEqual([
      { backend: 'claude', model: 'claude-sonnet-5', fix_mode: 'plan' },
    ])
  })

  it('identifies duplicate backend and model pairs', () => {
    expect(
      codeReviewConfigKey({ backend: 'codex', model: 'gpt-5.6-sol' })
    ).toBe('codex\u0000gpt-5.6-sol')
  })

  it('builds a session name that identifies the backend and model', () => {
    expect(
      getCodeReviewSessionName({ backend: 'codex', model: 'gpt-5.6-sol' })
    ).toBe('Code Review · Codex · gpt-5.6-sol')
  })

  it('resolves per-reviewer fix mode with global fallback', () => {
    expect(resolveCodeReviewFixMode({ fix_mode: 'yolo' })).toBe('yolo')
    expect(resolveCodeReviewFixMode({ fix_mode: null }, 'yolo')).toBe('yolo')
    expect(resolveCodeReviewFixMode(undefined)).toBe('plan')
  })
})
