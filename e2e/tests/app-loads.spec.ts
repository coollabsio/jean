import { test, expect } from '../fixtures/tauri-mock'

test.describe('App loads', () => {
  test('shows sidebar with project name', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })
  })

  test('shows dashboard empty state', async ({ mockPage }) => {
    await expect(
      mockPage.getByText('Your imagination is the only limit')
    ).toBeVisible({ timeout: 5000 })
  })

  test('shows connected status', async ({ mockPage }) => {
    await expect(mockPage.getByText('Connected')).toBeVisible({ timeout: 5000 })
  })
})
