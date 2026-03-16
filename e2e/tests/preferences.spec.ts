import { test, expect } from '../fixtures/tauri-mock'

test.describe('Preferences', () => {
  test('Cmd+, opens settings dialog', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await mockPage.keyboard.press('Meta+,')

    // Settings dialog should appear (titled "Settings")
    await expect(
      mockPage.getByRole('dialog').filter({ hasText: 'Settings' })
    ).toBeVisible({ timeout: 3000 })
  })

  test('settings dialog shows navigation tabs', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await mockPage.keyboard.press('Meta+,')

    const dialog = mockPage.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })

    // Should show setting section buttons
    await expect(dialog.getByRole('button', { name: 'General' })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Appearance' })
    ).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Keybindings' })
    ).toBeVisible()
  })
})
