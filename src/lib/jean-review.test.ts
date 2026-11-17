import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { buildJeanReviewPrompt, startJeanReviewSession } from './jean-review'
import { useChatStore } from '@/store/chat-store'
import {
  type AppPreferences,
  DEFAULT_CODE_REVIEW_PROMPT,
} from '@/types/preferences'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/transport', () => ({ invoke: invokeMock }))

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

describe('startJeanReviewSession', () => {
  it("runs the review in the first reviewer's configured mode", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'create_session' ? { id: 'review-session' } : null
    )

    const sessionId = await startJeanReviewSession({
      worktreeId: 'wt',
      worktreePath: '/tmp/wt',
      baseRef: 'origin/main',
      preferences: {
        magic_code_review_configs: [
          { backend: 'claude', model: 'sonnet', fix_mode: 'yolo' },
        ],
      } as unknown as AppPreferences,
      queryClient: new QueryClient(),
    })

    const startArgs = invokeMock.mock.calls.find(
      ([command]) => command === 'start_background_investigation'
    )?.[1]
    expect(startArgs.executionMode).toBe('yolo')
    expect(useChatStore.getState().executionModes[sessionId]).toBe('yolo')
  })
})
