import { describe, expect, it } from 'vitest'
import { buildJeanReviewPrompt } from './jean-review'
import { DEFAULT_CODE_REVIEW_PROMPT } from '@/types/preferences'

describe('buildJeanReviewPrompt', () => {
  it('fills the base branch into a custom prompt', () => {
    expect(
      buildJeanReviewPrompt('Review vs {base_branch}', 'origin/main')
    ).toBe('Review vs origin/main')
  })

  it('uses the default prompt for old structured-review templates with {diff}', () => {
    const prompt = buildJeanReviewPrompt('<diff>{diff}</diff>', 'origin/next')
    expect(prompt).toBe(
      DEFAULT_CODE_REVIEW_PROMPT.replaceAll('{base_branch}', 'origin/next')
    )
    expect(prompt).not.toContain('{diff}')
  })
})
