import { test, expect, activateWorktree } from '../fixtures/tauri-mock'

test.describe('Chat Messaging', () => {
  test('send a message and receive a streamed response', async ({
    mockPage,
    emitEvent,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await activateWorktree(mockPage, 'fuzzy-tiger')

    // Create a session first
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    // Find the chat textarea and send a message
    const textarea = mockPage.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 3000 })
    await textarea.fill('Hello Claude')
    await textarea.press('Enter')
    await mockPage.waitForTimeout(500)

    // Get session ID for events
    const sessionId = await mockPage
      .locator('[data-session-id]')
      .first()
      .getAttribute('data-session-id')

    // Simulate streaming response from backend
    await emitEvent('chat:sending', {
      session_id: sessionId,
      worktree_id: 'e2e',
    })
    await mockPage.waitForTimeout(100)

    await emitEvent('chat:chunk', {
      session_id: sessionId,
      content: 'Hello there! How can I help?',
    })
    await mockPage.waitForTimeout(200)

    // Streamed response should be visible while streaming
    await expect(
      mockPage.getByText('Hello there! How can I help?')
    ).toBeVisible({ timeout: 3000 })

    // Complete the stream
    await emitEvent('chat:done', {
      session_id: sessionId,
      worktree_id: 'e2e',
    })
  })

  test('streaming response renders incrementally', async ({
    mockPage,
    emitEvent,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await activateWorktree(mockPage, 'fuzzy-tiger')

    // Create a session
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    const textarea = mockPage.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 3000 })
    await textarea.fill('Tell me a joke')
    await textarea.press('Enter')
    await mockPage.waitForTimeout(300)

    const sessionId = await mockPage
      .locator('[data-session-id]')
      .first()
      .getAttribute('data-session-id')

    // Start streaming
    await emitEvent('chat:sending', {
      session_id: sessionId,
      worktree_id: 'e2e',
    })
    await mockPage.waitForTimeout(100)

    // First chunk
    await emitEvent('chat:chunk', {
      session_id: sessionId,
      content: 'Why did the ',
    })
    await mockPage.waitForTimeout(200)

    // Partial text should be visible
    await expect(mockPage.getByText('Why did the')).toBeVisible({
      timeout: 2000,
    })

    // Second chunk
    await emitEvent('chat:chunk', {
      session_id: sessionId,
      content: 'chicken cross the road?',
    })
    await mockPage.waitForTimeout(200)

    // Full text should be visible
    await expect(
      mockPage.getByText('Why did the chicken cross the road?')
    ).toBeVisible({ timeout: 2000 })

    // Complete
    await emitEvent('chat:done', {
      session_id: sessionId,
      worktree_id: 'e2e',
    })
  })
})
