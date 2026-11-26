import type { Page } from '@playwright/test'
import { test, expect, activateWorktree } from '../fixtures/tauri-mock'

// The permissions menu is nested in the model picker popover. Closing the
// menu or picking a mode must keep the picker open.

async function openPermissionsMenu(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await expect(page.getByText('Test Project')).toBeVisible({ timeout: 5000 })
  await activateWorktree(page, 'fuzzy-tiger')
  await page.getByRole('button', { name: 'New session' }).first().click()
  await page.getByText('Jean Chat').click()
  const picker = page
    .locator('button[aria-label="Choose backend and model"]')
    .first()
  await expect(picker).toBeVisible({ timeout: 10000 })
  await picker.click()
  const trigger = pickerPopover(page).locator(
    'button[aria-label^="Permissions"]'
  )
  await trigger.click()
  await expect(fullAccessItem(page)).toBeVisible()
  return trigger
}

const pickerPopover = (page: Page) =>
  page.locator('[data-slot="popover-content"]')
const fullAccessItem = (page: Page) =>
  page.getByRole('menuitemradio', { name: /Full access/ })

test.describe('Model picker permissions menu', () => {
  test('clicking the trigger again closes only the permissions menu', async ({
    mockPage,
  }) => {
    const trigger = await openPermissionsMenu(mockPage)
    const box = (await trigger.boundingBox())!
    await mockPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    await expect(fullAccessItem(mockPage)).toHaveCount(0)
    await expect(pickerPopover(mockPage)).toBeVisible()
  })

  for (const [fx, fy] of [
    [0.02, 0.5],
    [0.5, 0.9],
    [0.98, 0.5],
  ]) {
    test(`clicking the selected row at ${fx},${fy} keeps the picker open`, async ({
      mockPage,
    }) => {
      await openPermissionsMenu(mockPage)
      const box = (await fullAccessItem(mockPage).boundingBox())!
      await mockPage.mouse.click(
        box.x + box.width * fx,
        box.y + box.height * fy
      )

      await expect(fullAccessItem(mockPage)).toHaveCount(0)
      await expect(pickerPopover(mockPage)).toBeVisible()
    })
  }

  test('picking another mode keeps the picker open', async ({ mockPage }) => {
    await openPermissionsMenu(mockPage)
    await mockPage.getByRole('menuitemradio', { name: /Supervised/ }).click()

    await expect(fullAccessItem(mockPage)).toHaveCount(0)
    await expect(
      pickerPopover(mockPage).locator(
        'button[aria-label="Permissions: Supervised"]'
      )
    ).toBeVisible()
  })
})

test.describe('Model picker stays open after a change', () => {
  test('picking a model and an effort level keeps the picker open', async ({
    mockPage,
  }) => {
    await openPermissionsMenu(mockPage)
    await mockPage.keyboard.press('Escape')
    await expect(pickerPopover(mockPage)).toBeVisible()

    const unselected = pickerPopover(mockPage).locator('[cmdk-item]').nth(1)
    const modelName = (await unselected.innerText()).split('\n')[0]
    await unselected.click()
    await expect(pickerPopover(mockPage)).toBeVisible()
    await expect(
      mockPage.locator('button[aria-label="Choose backend and model"]').first()
    ).toContainText(modelName)

    const effort = pickerPopover(mockPage).getByRole('radio').last()
    await effort.click()
    await expect(effort).toHaveAttribute('aria-checked', 'true')
    await expect(pickerPopover(mockPage)).toBeVisible()
  })
})
