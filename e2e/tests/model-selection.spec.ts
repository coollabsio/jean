import { test, expect, activateWorktree } from '../fixtures/tauri-mock'

test.describe('Model Selection', () => {
  test('model selector shows current model in chat toolbar', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    // Navigate to a worktree chat view
    await activateWorktree(mockPage, 'fuzzy-tiger')

    // The default model is "sonnet" — toolbar should show "Sonnet" in a combobox
    const modelCombobox = mockPage.locator('button[role="combobox"]', {
      hasText: 'Sonnet',
    })
    await expect(modelCombobox).toBeVisible({ timeout: 3000 })
  })

  test('changing model updates the selector value', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await activateWorktree(mockPage, 'fuzzy-tiger')

    // Create a session first (model change requires an active session)
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    // Click the model selector combobox
    const modelCombobox = mockPage.locator('button[role="combobox"]', {
      hasText: 'Sonnet',
    })
    await expect(modelCombobox).toBeVisible({ timeout: 3000 })
    await modelCombobox.click()
    await mockPage.waitForTimeout(200)

    // Select "Opus 4.6"
    await mockPage.getByRole('option', { name: 'Opus 4.6' }).click()
    await mockPage.waitForTimeout(500)

    // Verify the selector now shows Opus 4.6
    const updatedCombobox = mockPage.locator('button[role="combobox"]', {
      hasText: 'Opus 4.6',
    })
    await expect(updatedCombobox).toBeVisible({ timeout: 3000 })
  })
})
