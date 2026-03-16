import { test, expect } from '../fixtures/tauri-mock'

test.describe('Theme Switching', () => {
  test('default theme applies dark or light class to html element', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    const hasDarkOrLight = await mockPage.evaluate(() => {
      const cl = document.documentElement.classList
      return cl.contains('dark') || cl.contains('light')
    })
    expect(hasDarkOrLight).toBe(true)
  })

  test('switching theme to dark updates html class', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    // Open settings
    await mockPage.keyboard.press('Meta+,')
    await mockPage.waitForTimeout(500)

    // Click Appearance tab
    await mockPage.getByText('Appearance').click()
    await mockPage.waitForTimeout(500)

    // Find the "Color theme" combobox — it's the one currently showing "System"
    const themeSelect = mockPage.locator('button[role="combobox"]', {
      hasText: 'System',
    })
    await expect(themeSelect).toBeVisible({ timeout: 3000 })
    await themeSelect.click()
    await mockPage.waitForTimeout(200)

    // Select "Dark"
    await mockPage.getByRole('option', { name: 'Dark' }).click()
    await mockPage.waitForTimeout(300)

    const isDark = await mockPage.evaluate(() =>
      document.documentElement.classList.contains('dark')
    )
    expect(isDark).toBe(true)
  })

  test('switching theme to light updates html class', async ({ mockPage }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    // Open settings
    await mockPage.keyboard.press('Meta+,')
    await mockPage.waitForTimeout(500)

    // Click Appearance tab
    await mockPage.getByText('Appearance').click()
    await mockPage.waitForTimeout(500)

    // Find the "Color theme" combobox — it's the one currently showing "System"
    const themeSelect = mockPage.locator('button[role="combobox"]', {
      hasText: 'System',
    })
    await expect(themeSelect).toBeVisible({ timeout: 3000 })
    await themeSelect.click()
    await mockPage.waitForTimeout(200)

    // Select "Light"
    await mockPage.getByRole('option', { name: 'Light' }).click()
    await mockPage.waitForTimeout(300)

    const isLight = await mockPage.evaluate(() =>
      document.documentElement.classList.contains('light')
    )
    expect(isLight).toBe(true)
  })
})
