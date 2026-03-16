import { test, expect, activateWorktree } from '../fixtures/tauri-mock'

test.describe('Session Management', () => {
  test('create new session via + button', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await activateWorktree(mockPage, 'fuzzy-tiger')

    // Click new session button
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    // A session tab should appear with data-session-id
    const sessionTab = mockPage.locator('[data-session-id]').first()
    await expect(sessionTab).toBeVisible({ timeout: 3000 })

    // Session name should contain "Session"
    await expect(sessionTab).toContainText('Session')
  })

  test('switch between sessions', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await activateWorktree(mockPage, 'fuzzy-tiger')

    // Create two sessions
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    // Should have 2 session tabs
    const tabs = mockPage.locator('[data-session-id]')
    await expect(tabs).toHaveCount(2, { timeout: 3000 })

    // Click the second tab (older session — "Session 1")
    const secondTab = tabs.nth(1)
    await secondTab.click()
    await mockPage.waitForTimeout(500)

    // The clicked tab should now have the active class (font-medium)
    await expect(secondTab).toHaveClass(/font-medium/, { timeout: 2000 })
  })

  test('rename session via double-click', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await activateWorktree(mockPage, 'fuzzy-tiger')

    // Create a session
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    const sessionTab = mockPage.locator('[data-session-id]').first()
    await expect(sessionTab).toBeVisible({ timeout: 3000 })

    // Double-click to enter edit mode
    await sessionTab.dblclick()
    await mockPage.waitForTimeout(300)

    // An input should appear
    const input = sessionTab.locator('input[type="text"]')
    await expect(input).toBeVisible({ timeout: 2000 })

    // Clear and type new name (force click to bypass DnD sortable disabled state)
    await input.click({ force: true })
    await mockPage.keyboard.press('Meta+a')
    await mockPage.keyboard.type('My Renamed Session')
    await mockPage.keyboard.press('Enter')
    await mockPage.waitForTimeout(300)

    // Tab should show the new name
    await expect(sessionTab).toContainText('My Renamed Session')
  })
})
