import { test, expect } from '../fixtures/tauri-mock'
import { project, worktree1, worktree2 } from '../fixtures/invoke-handlers'
import { createSession } from '../fixtures/mock-data'

const settings = {
  enabled: true,
  interval_minutes: 10,
  issue_limit: 1,
  max_parallel_worktrees: 2,
  planning_backend: 'claude',
  yolo_backend: 'claude',
  included_labels: ['bug'],
  excluded_labels: ['hold'],
}
const robotProject = { ...project, auto_fix_settings: settings }
const robot = {
  ...worktree2,
  origin: 'auto_fix',
  issue_number: 42,
  name: 'robot-only-worktree',
  labels: [{ name: 'Robot only', color: '#fff', pinned: true }],
  sessions: [createSession({ id: 'robot-session', name: 'Robot session' })],
}
const robotStatus = {
  lastScanAt: Date.now() / 1000 - 60,
  nextScanAt: Date.now() / 1000 + 540,
  rateLimitedUntil: null,
  lastError: null,
  failedIssues: [],
  startingIssues: [],
  pendingYoloSessions: 0,
  scanning: false,
  activeNow: true,
  lastScanSummary: '3 open issues · 1 next scan candidates',
  activity: [
    { at: Date.now() / 1000, message: 'Planning started', issueNumber: 42 },
  ],
}

test.use({
  responseOverrides: {
    list_projects: [robotProject],
    list_worktrees: [worktree1, robot],
    get_auto_fix_status: robotStatus,
    get_package_scripts: [],
    list_pending_wakeups: [],
    preview_auto_fix_issues: [
      {
        issueNumber: 42,
        labels: ['bug'],
        selected: false,
        reason: 'Worktree already exists',
      },
      {
        issueNumber: 43,
        labels: ['bug'],
        selected: true,
        reason: 'Next scan candidate',
      },
      {
        issueNumber: 44,
        labels: ['hold'],
        selected: false,
        reason: 'Excluded label',
      },
    ],
    request_auto_fix_scan: null,
  },
})

for (const viewport of [
  { name: 'desktop web', width: 1280, height: 900 },
  { name: 'mobile web', width: 390, height: 844 },
]) {
  test(`${viewport.name}: automation stays in Mr. Robot after tab changes and reload`, async ({
    mockPage,
  }) => {
    await mockPage.setViewportSize(viewport)
    const robotSection = mockPage.locator(
      `[data-pdnd-worktree-scope="canvas-worktree-list"][data-pdnd-worktree-id="${robot.id}"]`
    )
    const normalSection = mockPage.locator(
      `[data-pdnd-worktree-scope="canvas-worktree-list"][data-pdnd-worktree-id="${worktree1.id}"]`
    )
    await expect(normalSection).toBeVisible()
    await expect(robotSection).toHaveCount(0)
    await expect(mockPage.getByRole('tab', { name: /Robot only/ })).toHaveCount(
      0
    )
    await mockPage.getByRole('tab', { name: /Mr. Robot/ }).click()
    await expect(robotSection).toBeVisible()
    await expect(normalSection).toHaveCount(0)
    const panel = mockPage.getByRole('region', { name: 'Mr. Robot status' })
    await panel.getByRole('button', { name: 'Preview issues' }).click()
    await expect(
      panel.getByText('Excluded label', { exact: true })
    ).toBeVisible()
    await expect(
      panel.getByText('Next scan candidate', { exact: true })
    ).toBeVisible()
    await panel.getByRole('button', { name: 'Scan now' }).click()
    await expect(
      mockPage.getByText('Scan requested', { exact: true })
    ).toBeVisible()
    await panel.getByText('Recent activity', { exact: true }).click()
    await expect(
      panel.getByText('Planning started', { exact: false })
    ).toBeVisible()
    await mockPage.screenshot({
      path: `/tmp/mr-robot-${viewport.width}.png`,
      fullPage: true,
    })
    await mockPage.getByRole('tab', { name: /^All/ }).click()
    await expect(normalSection).toBeVisible()
    await expect(robotSection).toHaveCount(0)
    if (viewport.width > 600) {
      const search = mockPage.getByRole('textbox', {
        name: 'Search worktrees and sessions',
      })
      await search.fill('Robot session')
      await expect(robotSection).toHaveCount(0)
      await expect(normalSection).toHaveCount(0)
      await mockPage.getByRole('tab', { name: /Mr. Robot/ }).click()
      await expect(robotSection).toBeVisible()
      await search.fill('')
      await mockPage.getByRole('tab', { name: /^All/ }).click()
    }
    await mockPage.reload()
    await expect(normalSection).toBeVisible()
    await expect(robotSection).toHaveCount(0)
  })
}

test('pause and resume change only the enabled setting and keep the automation worktree available', async ({
  mockPage,
}) => {
  await mockPage.getByRole('tab', { name: /Mr. Robot/ }).click()
  const panel = mockPage.getByRole('region', { name: 'Mr. Robot status' })
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeEnabled()
  await mockPage.evaluate(() => {
    const mock = (window as any).__JEAN_E2E_MOCK__
    let projects = mock.invokeHandlers.list_projects()
    mock.invokeHandlers.list_projects = () => structuredClone(projects)
    mock.invokeHandlers.update_project_settings = (args: any) => {
      projects = projects.map((project: any) =>
        project.id === args.projectId
          ? { ...project, auto_fix_settings: args.autoFixSettings }
          : project
      )
      return structuredClone(
        projects.find((project: any) => project.id === args.projectId)
      )
    }
  })
  await panel.getByRole('button', { name: 'Pause new work' }).click()
  await expect(
    panel.getByRole('button', { name: 'Resume new work' })
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeDisabled()
  const pausedSettings = await mockPage.evaluate(
    () =>
      (window as any).__JEAN_E2E_MOCK__.invokeHandlers.list_projects()[0]
        .auto_fix_settings
  )
  expect(pausedSettings).toEqual({ ...settings, enabled: false })
  await expect(
    mockPage.locator(
      `[data-pdnd-worktree-scope="canvas-worktree-list"][data-pdnd-worktree-id="${robot.id}"]`
    )
  ).toBeVisible()
  await panel.getByRole('button', { name: 'Resume new work' }).click()
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeEnabled()
  const resumedSettings = await mockPage.evaluate(
    () =>
      (window as any).__JEAN_E2E_MOCK__.invokeHandlers.list_projects()[0]
        .auto_fix_settings
  )
  expect(resumedSettings).toEqual(settings)
})
