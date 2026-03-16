import { test, expect } from '../fixtures/tauri-mock'

test.describe('Keyboard shortcuts', () => {
  test('Cmd+K opens command palette', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await mockPage.keyboard.press('Meta+k')

    const input = mockPage.locator('[cmdk-input]')
    await expect(input).toBeVisible({ timeout: 3000 })
  })

  test('Cmd+B toggles sidebar panel', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    // Toggle sidebar on (may start hidden or visible depending on default)
    await mockPage.keyboard.press('Meta+b')
    await mockPage.waitForTimeout(300)

    // Check if PROJECTS header appeared (sidebar panel open)
    const projectsHeader = mockPage.getByText('PROJECTS')
    const sidebarVisible = await projectsHeader.isVisible().catch(() => false)

    if (sidebarVisible) {
      // Sidebar opened — toggle it closed
      await mockPage.keyboard.press('Meta+b')
      await mockPage.waitForTimeout(300)
      await expect(projectsHeader).not.toBeVisible({ timeout: 2000 })
    } else {
      // Sidebar was already open and we closed it — toggle it back open
      await mockPage.keyboard.press('Meta+b')
      await mockPage.waitForTimeout(300)
      await expect(projectsHeader).toBeVisible({ timeout: 2000 })
    }
  })

  test('Escape closes command palette', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    await mockPage.keyboard.press('Meta+k')
    const input = mockPage.locator('[cmdk-input]')
    await expect(input).toBeVisible({ timeout: 3000 })

    await mockPage.keyboard.press('Escape')
    await expect(input).not.toBeVisible({ timeout: 2000 })
  })
})
