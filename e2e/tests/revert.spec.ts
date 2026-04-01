import { test, expect, activateWorktree } from '../fixtures/tauri-mock'

async function seedSessionWithMessages(
  mockPage: Parameters<typeof test>[0]['mockPage'],
  sessionId: string
) {
  await mockPage.evaluate(
    ({ sessionId }) => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      const stores = Object.values(mock.sessionStore ?? {}) as Array<{
        sessions: Array<Record<string, unknown>>
      }>
      const session = stores
        .flatMap(store => store.sessions)
        .find(candidate => candidate.id === sessionId)
      if (!session) throw new Error(`Session ${sessionId} not found`)

      session.updated_at = Date.now() / 1000
      session.messages = [
        {
          id: 'user-1',
          session_id: sessionId,
          role: 'user',
          content: 'First prompt',
          timestamp: 1,
          tool_calls: [],
        },
        {
          id: 'assistant-1',
          session_id: sessionId,
          role: 'assistant',
          content: 'First reply',
          timestamp: 2,
          tool_calls: [],
          content_blocks: [{ type: 'text', text: 'First reply' }],
        },
        {
          id: 'user-2',
          session_id: sessionId,
          role: 'user',
          content: 'Second prompt',
          timestamp: 3,
          tool_calls: [],
        },
        {
          id: 'assistant-2',
          session_id: sessionId,
          role: 'assistant',
          content: 'Second reply',
          timestamp: 4,
          tool_calls: [],
          content_blocks: [{ type: 'text', text: 'Second reply' }],
        },
      ]
      session.revert_targets = [
        { userMessageId: 'user-1', available: true, reason: 'ready' },
        { userMessageId: 'user-2', available: true, reason: 'ready' },
      ]
    },
    { sessionId }
  )
}

test.describe('Thread revert', () => {
  test('reverts from a user message after confirmation', async ({
    mockPage,
    emitEvent,
  }) => {
    await activateWorktree(mockPage, 'fuzzy-tiger')

    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(300)

    const sessionId = await mockPage
      .locator('[data-session-id]')
      .first()
      .getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()

    await seedSessionWithMessages(mockPage, sessionId!)
    await emitEvent('cache:invalidate', { keys: ['sessions'] })

    await expect(mockPage.getByText('First prompt')).toBeVisible()
    await expect(mockPage.getByText('Second prompt')).toBeVisible()

    await mockPage.getByText('Second prompt').hover()
    const revertButton = mockPage
      .getByRole('button', { name: /revert to this message/i })
      .last()
    await expect(revertButton).toBeVisible()
    await revertButton.click()

    await expect(
      mockPage.getByRole('heading', {
        name: 'Revert this thread to checkpoint?',
      })
    ).toBeVisible()
    await expect(
      mockPage.getByText(
        'This will discard newer messages and turn diffs in this thread.'
      )
    ).toBeVisible()
    await expect(
      mockPage.getByText('This action cannot be undone.')
    ).toBeVisible()

    await mockPage.getByRole('button', { name: 'Revert thread' }).click()

    await expect(mockPage.getByText('First prompt')).toBeVisible()
    await expect(mockPage.getByText('First reply')).toBeVisible()
    await expect(mockPage.getByText('Second prompt')).not.toBeVisible()
    await expect(mockPage.getByText('Second reply')).not.toBeVisible()
  })

  test('does not show revert for non-revertable user messages', async ({
    mockPage,
    emitEvent,
  }) => {
    await activateWorktree(mockPage, 'fuzzy-tiger')

    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(300)

    const sessionId = await mockPage
      .locator('[data-session-id]')
      .first()
      .getAttribute('data-session-id')
    expect(sessionId).toBeTruthy()

    await seedSessionWithMessages(mockPage, sessionId!)
    await mockPage.evaluate(
      ({ sessionId }) => {
        const mock = (window as any).__JEAN_E2E_MOCK__
        const stores = Object.values(mock.sessionStore ?? {}) as Array<{
          sessions: Array<Record<string, unknown>>
        }>
        const session = stores
          .flatMap(store => store.sessions)
          .find(candidate => candidate.id === sessionId)
        if (!session) throw new Error(`Session ${sessionId} not found`)

        session.revert_targets = [
          {
            userMessageId: 'user-1',
            available: false,
            reason: 'missing_checkpoint',
          },
        ]
      },
      { sessionId }
    )
    await emitEvent('cache:invalidate', { keys: ['sessions'] })

    await mockPage.getByText('First prompt').hover()
    await expect(
      mockPage.getByRole('button', { name: /revert to this message/i })
    ).not.toBeVisible()
  })
})
