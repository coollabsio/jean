import { test, expect, activateWorktree } from '../fixtures/tauri-mock'
import type { Page } from '@playwright/test'

async function openFixture(page: Page, fixture: string) {
  await page.goto(`/?fixture=${fixture}`)
  await expect(page.getByText('Test Project')).toBeVisible({ timeout: 5000 })
  await activateWorktree(page, 'fuzzy-tiger')
}

const tabNames = (page: Page) =>
  page.locator('[role="tablist"][aria-label="Sessions"] [role="tab"]')

test.describe('Sub-sessions', () => {
  test('tabs show sub-sessions right after their lead', async ({
    mockPage,
  }) => {
    await openFixture(mockPage, 'delegation')

    // Running sessions sort last among their siblings, but a sub-session
    // stays with its lead.
    await expect(tabNames(mockPage)).toHaveText([
      'Plan the release',
      'Check CI',
      'Write changelog',
      'Fix flaky test',
    ])
    // A lead with a running sub-session cannot hide it.
    await expect(
      mockPage.getByRole('button', { name: 'Hide sub-sessions' })
    ).toHaveCount(0)
  })

  test('the lead lists its sub-sessions beside the chat, or above the composer when narrow', async ({
    mockPage,
  }) => {
    await mockPage.setViewportSize({ width: 1700, height: 900 })
    await openFixture(mockPage, 'delegation')
    await tabNames(mockPage).filter({ hasText: 'Plan the release' }).click()

    const panel = mockPage.getByRole('complementary', { name: 'Sub-sessions' })
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('sub-session-card')).toHaveText([
      /Write changelog/,
      /Check CI.*CI is green on main\./,
    ])
    await expect(panel).not.toContainText('Fix flaky test')

    await mockPage.setViewportSize({ width: 900, height: 700 })
    await expect(panel).toBeHidden()
    const strip = mockPage.getByTestId('sub-session-strip')
    await expect(strip).toContainText('Sub-sessions')
    await strip.getByRole('button', { name: /Sub-sessions/ }).click()
    await expect(strip.getByTestId('sub-session-card')).toHaveText([
      /Write changelog/,
      /Check CI/,
    ])
  })

  test('collapsing a lead hides its finished sub-sessions from tabs and shortcuts', async ({
    mockPage,
  }) => {
    await openFixture(mockPage, 'delegation-finished')
    const tabs = mockPage.locator(
      '[role="tablist"][aria-label="Sessions"] [data-session-id]'
    )
    const leadTab = tabs.filter({ hasText: 'Plan the release' })

    await leadTab.click()
    await leadTab.hover()
    await leadTab.getByRole('button', { name: 'Hide sub-sessions' }).click()

    await expect(tabNames(mockPage)).toHaveText([
      'Plan the release',
      'Fix flaky test',
    ])
    await expect(
      leadTab.getByRole('button', { name: 'Show sub-sessions' })
    ).toBeVisible()

    // The second visible tab is the next tab for keyboard switching.
    await mockPage.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('switch-session', { detail: { index: 1 } })
      )
    )
    await expect(
      tabs.filter({ hasText: 'Fix flaky test' }).getByRole('tab')
    ).toHaveAttribute('aria-selected', 'true')
  })
})
