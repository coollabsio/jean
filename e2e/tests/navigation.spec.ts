import { test, expect } from '../fixtures/tauri-mock'

test.describe('Navigation', () => {
  test('sidebar shows project with worktrees', async ({ mockPage }) => {
    // Wait for app to load
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    // Open sidebar panel if not visible
    const projectsHeader = mockPage.getByRole('tab', { name: 'Workspace' })
    if (!(await projectsHeader.isVisible().catch(() => false))) {
      await mockPage.keyboard.press('ControlOrMeta+b')
      await mockPage.waitForTimeout(500)
    }

    // Sidebar should show project and worktrees
    await expect(projectsHeader).toBeVisible({ timeout: 3000 })
    await expect(
      mockPage.getByRole('button', { name: 'fuzzy-tiger Expand sessions' })
    ).toBeVisible({
      timeout: 3000,
    })
    await expect(
      mockPage.getByRole('button', { name: 'calm-dolphin Expand sessions' })
    ).toBeVisible({
      timeout: 3000,
    })
  })

  test('click worktree navigates to chat view', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    // Open sidebar
    const projectsHeader = mockPage.getByRole('tab', { name: 'Workspace' })
    if (!(await projectsHeader.isVisible().catch(() => false))) {
      await mockPage.keyboard.press('ControlOrMeta+b')
      await mockPage.waitForTimeout(500)
    }

    // Click a worktree
    await mockPage
      .getByRole('button', { name: 'fuzzy-tiger Expand sessions' })
      .click()
    await mockPage.waitForTimeout(1000)

    // Dashboard empty state should no longer be visible
    await expect(
      mockPage.getByText('Your imagination is the only limit')
    ).not.toBeVisible({ timeout: 3000 })
  })
})
