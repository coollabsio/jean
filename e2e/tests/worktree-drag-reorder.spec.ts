import { test, expect } from '../fixtures/tauri-mock'
import { project, worktree1, worktree2 } from '../fixtures/invoke-handlers'
import { createSession } from '../fixtures/mock-data'

const baseWorktree = {
  ...worktree1,
  id: 'base-worktree',
  name: 'Base Session',
  branch: project.default_branch,
  path: project.path,
  session_type: 'base',
  order: 0,
  sessions: [createSession({ id: 'base-session', name: 'Base Session' })],
}

test.describe('Worktree drag reorder', () => {
  test.describe('canvas base session gutter', () => {
    test.use({
      responseOverrides: {
        list_worktrees: [
          baseWorktree,
          {
            ...worktree1,
            order: 1,
            sessions: [createSession({ id: 'worktree-1-session' })],
          },
          {
            ...worktree2,
            order: 2,
            sessions: [createSession({ id: 'worktree-2-session' })],
          },
        ],
      },
    })

    test('aligns the base session with reorderable worktrees without showing a handle', async ({
      mockPage,
    }) => {
      await expect(mockPage.getByText('Test Project')).toBeVisible({
        timeout: 5000,
      })

      const baseSection = mockPage.locator(
        `[data-pdnd-worktree-scope="canvas-worktree-list"][data-pdnd-worktree-id="${baseWorktree.id}"]`
      )

      await expect(baseSection).toBeVisible()
      const worktreeSection = mockPage.locator(
        `[data-pdnd-worktree-scope="canvas-worktree-list"][data-pdnd-worktree-id="${worktree1.id}"]`
      )

      await expect(worktreeSection).toBeVisible()
      const baseBox = await baseSection.boundingBox()
      const worktreeBox = await worktreeSection.boundingBox()
      expect(baseBox).not.toBeNull()
      expect(worktreeBox).not.toBeNull()
      expect(Math.round(baseBox!.x)).toBe(Math.round(worktreeBox!.x))
      await expect(
        baseSection.getByRole('button', { name: /reorder base session/i })
      ).toHaveCount(0)
    })

    test('moves the selected canvas worktree with Meta+ArrowUp and Meta+ArrowDown', async ({
      mockPage,
    }) => {
      await expect(mockPage.getByText('Test Project')).toBeVisible({
        timeout: 5000,
      })

      await mockPage.keyboard.press('ArrowDown')
      await mockPage.waitForTimeout(100)
      await mockPage.keyboard.press('ControlOrMeta+ArrowDown')

      await expect
        .poll(async () =>
          mockPage
            .locator('[data-pdnd-worktree-scope="canvas-worktree-list"]')
            .evaluateAll(rows =>
              rows.map(row => (row as HTMLElement).dataset.pdndWorktreeId)
            )
        )
        .toEqual([baseWorktree.id, worktree2.id, worktree1.id])

      await mockPage.waitForTimeout(100)
      await mockPage.keyboard.press('ControlOrMeta+ArrowUp')

      await expect
        .poll(async () =>
          mockPage
            .locator('[data-pdnd-worktree-scope="canvas-worktree-list"]')
            .evaluateAll(rows =>
              rows.map(row => (row as HTMLElement).dataset.pdndWorktreeId)
            )
        )
        .toEqual([baseWorktree.id, worktree1.id, worktree2.id])
    })
  })

  test('reorders sidebar worktrees with the Pragmatic DnD drop indicator', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })

    const projectsHeader = mockPage.getByRole('tab', { name: 'Workspace' })
    if (!(await projectsHeader.isVisible().catch(() => false))) {
      await mockPage.keyboard.press('ControlOrMeta+b')
      await mockPage.waitForTimeout(500)
    }
    await expect(projectsHeader).toBeVisible({ timeout: 3000 })

    const source = mockPage.locator(
      `[data-pdnd-worktree-scope="worktree-list"][data-pdnd-worktree-id="${worktree1.id}"]`
    )
    const target = mockPage.locator(
      `[data-pdnd-worktree-scope="worktree-list"][data-pdnd-worktree-id="${worktree2.id}"]`
    )

    await expect(source).toBeVisible()
    await expect(target).toBeVisible()

    const sourceBox = await source.boundingBox()
    const targetBox = await target.boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    if (!sourceBox || !targetBox) return

    await mockPage.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2
    )
    await mockPage.mouse.down()
    await mockPage.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2 + 12,
      { steps: 4 }
    )
    await mockPage.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + targetBox.height * 0.85,
      { steps: 12 }
    )

    await expect(mockPage.getByTestId('drop-indicator')).toBeVisible()

    await mockPage.mouse.up()

    await expect
      .poll(async () =>
        mockPage
          .locator('[data-pdnd-worktree-scope="worktree-list"]')
          .evaluateAll(rows =>
            rows.map(row => (row as HTMLElement).dataset.pdndWorktreeId)
          )
      )
      .toEqual([worktree2.id, worktree1.id])
  })
})
