import { expect, test } from '../fixtures/tauri-mock'

test.describe('Collapsed sidebar edge hover', () => {
  test.beforeEach(async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })
    await expect(
      mockPage.getByRole('button', { name: 'Show Left Sidebar' })
    ).toBeVisible()
  })

  test('opens temporarily without pinning after navigation', async ({
    mockPage,
  }) => {
    await mockPage.getByTestId('sidebar-hover-hotspot').hover()
    const preview = mockPage.getByTestId('sidebar-hover-preview')
    await expect(preview).toBeVisible({ timeout: 1500 })

    await preview.getByText('fuzzy-tiger').click()
    await mockPage.mouse.move(700, 120)
    await expect(preview).toBeHidden({ timeout: 1500 })
    await expect(
      mockPage.getByRole('button', { name: 'Show Left Sidebar' })
    ).toBeVisible()
  })

  test('pins the temporary sidebar only through the sidebar toggle', async ({
    mockPage,
  }) => {
    await mockPage.getByTestId('sidebar-hover-hotspot').hover()
    await expect(mockPage.getByTestId('sidebar-hover-preview')).toBeVisible({
      timeout: 1500,
    })

    await mockPage.getByRole('button', { name: 'Show Left Sidebar' }).click()
    await mockPage.mouse.move(700, 120)

    await expect(mockPage.getByTestId('sidebar-hover-preview')).toBeHidden()
    await expect(
      mockPage.getByRole('button', { name: 'Hide Left Sidebar' })
    ).toBeVisible()
  })
})
