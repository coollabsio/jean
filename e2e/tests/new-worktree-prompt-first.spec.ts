import { test, expect } from '../fixtures/tauri-mock'
import { project as defaultProject } from '../fixtures/invoke-handlers'
import type { Page } from '@playwright/test'

test.setTimeout(60_000)

async function openPromptFirstComposer(page: Page) {
  await expect(page.getByText('Test Project')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Project actions' }).click()
  await page.getByRole('menuitem', { name: 'New Worktree' }).click()
  const composer = page.getByRole('dialog', { name: 'Start something new' })
  await expect(composer).toBeVisible()
  return composer
}

async function installSuccessfulCreation(page: Page, prefix: string) {
  await page.evaluate(prefixValue => {
    const win = window as any
    const mock = win.__JEAN_E2E_MOCK__
    win.__WORKFLOW_CREATE_ARGS__ = []
    let count = 0
    mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
      count += 1
      win.__WORKFLOW_CREATE_ARGS__.push(args)
      const id = `${prefixValue}-${count}`
      const worktree = {
        id,
        project_id: args.projectId,
        name: id,
        path: `/tmp/e2e-test-project/.worktrees/${id}`,
        branch: id,
        created_at: Date.now() / 1000,
        order: 0,
        session_type: 'worktree',
        status: 'pending',
      }
      setTimeout(() => {
        mock.eventEmitter.dispatchEvent(
          new CustomEvent('worktree:created', {
            detail: {
              worktree: { ...worktree, status: 'ready' },
              autoOpenInJean: false,
            },
          })
        )
      }, 50)
      return worktree
    }
  }, prefix)
}

const secondProject = {
  ...defaultProject,
  id: 'project-second',
  name: 'Second Project',
  path: '/tmp/e2e-second-project',
  default_branch: 'develop',
  order: 1,
}

const issue = {
  number: 101,
  title: 'Make onboarding reliable',
  body: 'Issue body',
  state: 'OPEN',
  labels: [],
  created_at: '2026-08-07T08:00:00Z',
  author: { login: 'fares' },
}

const pullRequest = {
  number: 201,
  title: 'Improve the release flow',
  body: 'PR body',
  state: 'OPEN',
  headRefName: 'feature/release-flow',
  baseRefName: 'main',
  isDraft: false,
  created_at: '2026-08-07T08:00:00Z',
  author: { login: 'fares' },
  labels: [],
  comments: [],
  reviews: [],
}

const promptFirstSkill = {
  name: 'prompt-first-review',
  path: '/tmp/e2e-skills/prompt-first-review/SKILL.md',
  description: 'Review the prompt-first workflow',
}

test.describe('Prompt-first worktree creation', () => {
  test.use({
    responseOverrides: {
      list_projects: [defaultProject, secondProject],
      list_github_issues: { issues: [issue], has_next_page: false },
      list_github_prs: [pullRequest],
      get_github_pr: pullRequest,
      get_project_branches: ['main', 'develop', 'feature/existing'],
      get_jean_config: { scripts: { setup: null, run: [] } },
      list_claude_skills: [promptFirstSkill],
    },
  })

  test('shows a selected skill inside the prompt composer', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'skill-worktree')
    await mockPage.evaluate(() => {
      const win = window as any
      win.__SKILL_SEND_ARGS__ = []
      win.__JEAN_E2E_MOCK__.invokeHandlers.send_chat_message = (
        args: Record<string, unknown>
      ) => {
        win.__SKILL_SEND_ARGS__.push(args)
        return { id: 'assistant-response', role: 'assistant', content: 'Done' }
      }
    })
    const composer = await openPromptFirstComposer(mockPage)
    const prompt = composer.getByLabel('Prompt')

    await prompt.fill('/')
    await mockPage
      .getByRole('option', { name: /prompt-first-review/ })
      .click()

    await expect(
      composer.getByText('/prompt-first-review', { exact: true })
    ).toBeVisible()
    await expect(prompt).toHaveValue('')

    await composer.getByRole('button', { name: 'Remove skill' }).click()
    await expect(
      composer.getByText('/prompt-first-review', { exact: true })
    ).toBeHidden()

    await prompt.fill('/')
    await mockPage
      .getByRole('option', { name: /prompt-first-review/ })
      .click()
    await composer
      .getByRole('button', { name: /^Create worktree & start\s*↵$/ })
      .click()

    await expect
      .poll(() =>
        mockPage.evaluate(() => (window as any).__SKILL_SEND_ARGS__.length)
      )
      .toBe(1)
    expect(
      await mockPage.evaluate(
        () => (window as any).__SKILL_SEND_ARGS__[0].message
      )
    ).toContain(
      '[Skill: /tmp/e2e-skills/prompt-first-review/SKILL.md - Read and use this skill to guide your response]'
    )
  })

  test('opens on the prompt and keeps it while attaching an issue', async ({
    mockPage,
  }) => {
    await expect(
      mockPage.getByRole('heading', { name: 'Test Project' })
    ).toBeVisible({
      timeout: 15_000,
    })

    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await expect(composer).toBeVisible()
    const composerBounds = await composer.boundingBox()
    expect(composerBounds).not.toBeNull()
    expect(composerBounds?.width).toBeLessThanOrEqual(780)
    expect(composerBounds?.height).toBeLessThan(320)
    const promptAreaBounds = await composer
      .locator('.cursor-text')
      .boundingBox()
    expect(promptAreaBounds).not.toBeNull()
    expect(promptAreaBounds?.height).toBeGreaterThanOrEqual(112)
    await expect(
      composer.getByRole('button', { name: /^Create worktree\s*↵$/ })
    ).toBeEnabled()

    const prompt = composer.getByLabel('Prompt')
    await prompt.fill('Fix the onboarding flow')
    await expect(
      composer.getByRole('button', { name: /^Create worktree & start/ })
    ).toBeEnabled()

    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await expect(
      mockPage.getByRole('menuitem', { name: /Worktree options/i })
    ).toBeVisible()
    await mockPage.getByRole('menuitem', { name: /Worktree options/i }).click()
    await expect(
      composer.getByRole('button', { name: 'Base branch: main' })
    ).toBeVisible()
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'GitHub issue' }).click()

    const sourceBrowser = mockPage.getByRole('dialog', {
      name: 'Create from existing context',
    })
    await expect(sourceBrowser).toBeVisible()
    await sourceBrowser
      .getByRole('button', { name: /#101.*onboarding/i })
      .click()

    await expect(composer).toBeVisible()
    await expect(composer.getByText('GitHub issue #101')).toBeVisible()
    await expect(prompt).toHaveValue('Fix the onboarding flow')
    await expect(
      composer.getByRole('button', { name: /^Create worktree & start/ })
    ).toBeEnabled()
  })

  test('restores the complete draft after an accidental close', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    let composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer.getByLabel('Prompt').fill('Keep my complete draft')
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'GitHub issue' }).click()
    await mockPage
      .getByRole('dialog', { name: 'Create from existing context' })
      .getByRole('button', { name: /#101.*onboarding/i })
      .click()
    await expect(composer.getByText('GitHub issue #101')).toBeVisible()

    await composer.press('Escape')
    await expect(composer).toBeHidden()
    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    composer = mockPage.getByRole('dialog', { name: 'Start something new' })

    await expect(composer.getByLabel('Prompt')).toHaveValue(
      'Keep my complete draft'
    )
    await expect(composer.getByText('GitHub issue #101')).toBeVisible()
  })

  test('reopens on the conversation composer after closing a source browser', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer.getByLabel('Prompt').fill('Keep this draft')
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    const menu = mockPage.getByRole('menu')
    await menu.getByRole('menuitem', { name: /GitHub issue/i }).click()

    const sourceBrowser = mockPage.getByRole('dialog', {
      name: 'Create from existing context',
    })
    await expect(sourceBrowser).toBeVisible()
    await sourceBrowser.press('Escape')
    await expect(sourceBrowser).toBeHidden()
    await expect(composer).toBeVisible()
    await expect(composer.getByLabel('Prompt')).toHaveValue('Keep this draft')
  })

  test('switches project from the composer and keeps drafts isolated', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer.getByLabel('Prompt').fill('Draft for Test Project')

    await composer.getByRole('button', { name: 'Choose project' }).click()
    await mockPage.getByRole('menuitem', { name: /Second Project/ }).click()
    await expect(
      composer.getByRole('button', { name: 'Choose project' })
    ).toContainText('Second Project')
    await expect(composer.getByLabel('Prompt')).toHaveValue('')
    await expect(
      composer.getByRole('button', { name: 'Choose starting point' })
    ).toContainText('New worktree from develop')

    await composer.getByLabel('Prompt').fill('Draft for Second Project')
    await composer.getByRole('button', { name: 'Choose project' }).click()
    await mockPage.getByRole('menuitem', { name: /Test Project/ }).click()
    await expect(composer.getByLabel('Prompt')).toHaveValue(
      'Draft for Test Project'
    )
  })

  test('creates in background, opens the session and starts the prompt', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.evaluate(() => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      ;(window as any).__PROMPT_FIRST_SEND_ARGS__ = []
      mock.invokeHandlers.send_chat_message = (
        args: Record<string, unknown>
      ) => {
        ;(window as any).__PROMPT_FIRST_SEND_ARGS__.push(args)
        return { id: 'assistant-response', role: 'assistant', content: 'Done' }
      }
      mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
        ;(window as any).__PROMPT_FIRST_CREATE_ARGS__ = args
        const worktree = {
          id: 'prompt-first-worktree',
          project_id: args.projectId,
          name: 'prompt-first-worktree',
          path: '/tmp/e2e-test-project/.worktrees/prompt-first-worktree',
          branch: 'prompt-first-worktree',
          created_at: Date.now() / 1000,
          order: 0,
          session_type: 'worktree',
          status: 'pending',
        }
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:created', {
              detail: {
                worktree: { ...worktree, status: 'ready' },
                autoOpenInJean: false,
              },
            })
          )
        }, 100)
        return worktree
      }
    })

    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer.getByLabel('Prompt').fill('Build the reliable flow')
    await composer.getByLabel('Prompt').press('Enter')

    await expect(composer).toBeHidden()
    await expect
      .poll(() =>
        mockPage.evaluate(
          () => (window as any).__PROMPT_FIRST_SEND_ARGS__.length
        )
      )
      .toBe(1)
    expect(
      await mockPage.evaluate(
        () => (window as any).__PROMPT_FIRST_SEND_ARGS__[0].message
      )
    ).toBe('Build the reliable flow')
    const args = await mockPage.evaluate(
      () => (window as any).__PROMPT_FIRST_CREATE_ARGS__
    )
    expect(args).toMatchObject({
      baseBranch: 'main',
      autoOpenInJean: false,
    })
  })

  test('adds a file visibly and starts the conversation without text', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'attachment-worktree')
    await mockPage.evaluate(() => {
      const win = window as any
      const mock = win.__JEAN_E2E_MOCK__
      win.__ATTACHMENT_SEND_ARGS__ = []
      mock.invokeHandlers.save_pasted_image = () => ({
        id: 'saved-attachment',
        path: '/tmp/prompt-first-attachment.png',
        filename: 'prompt-first-attachment.png',
      })
      mock.invokeHandlers.send_chat_message = (
        args: Record<string, unknown>
      ) => {
        win.__ATTACHMENT_SEND_ARGS__.push(args)
        return { id: 'assistant-response', role: 'assistant', content: 'Done' }
      }
    })

    const composer = await openPromptFirstComposer(mockPage)
    await composer.locator('input[type="file"]').setInputFiles({
      name: 'proof.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not-a-real-png'),
    })

    await expect(
      composer.getByAltText('prompt-first-attachment.png')
    ).toBeVisible()
    await composer
      .getByRole('button', { name: /^Create worktree & start\s*↵$/ })
      .click()

    await expect
      .poll(() =>
        mockPage.evaluate(() => (window as any).__ATTACHMENT_SEND_ARGS__.length)
      )
      .toBe(1)
    expect(
      await mockPage.evaluate(
        () => (window as any).__ATTACHMENT_SEND_ARGS__[0].message
      )
    ).toContain('/tmp/prompt-first-attachment.png')
  })

  test('keeps the composer ready for another worktree when Create more is enabled', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.evaluate(() => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
        const worktree = {
          id: 'create-more-worktree',
          project_id: args.projectId,
          name: 'create-more-worktree',
          path: '/tmp/e2e-test-project/.worktrees/create-more-worktree',
          branch: 'create-more-worktree',
          created_at: Date.now() / 1000,
          order: 0,
          session_type: 'worktree',
          status: 'pending',
        }
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:created', {
              detail: {
                worktree: { ...worktree, status: 'ready' },
                autoOpenInJean: false,
              },
            })
          )
        }, 100)
        return worktree
      }
    })

    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer.getByRole('switch', { name: 'Create more' }).click()
    await composer.getByLabel('Prompt').fill('Create one and stay here')
    await composer.getByLabel('Prompt').press('Enter')

    await expect(composer).toBeVisible()
    await expect(composer.getByLabel('Prompt')).toHaveValue('', {
      timeout: 10_000,
    })
    await expect(
      composer.getByRole('button', { name: /^Create worktree\s*↵$/ })
    ).toBeEnabled()
  })

  test('restores the full prompt after a background creation error', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.evaluate(() => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
        const worktree = {
          id: 'failed-worktree',
          project_id: args.projectId,
          name: 'failed-worktree',
          path: '/tmp/e2e-test-project/.worktrees/failed-worktree',
          branch: 'failed-worktree',
          created_at: Date.now() / 1000,
          order: 0,
          session_type: 'worktree',
          status: 'pending',
        }
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:error', {
              detail: {
                id: worktree.id,
                project_id: args.projectId,
                error: 'Branch already exists',
              },
            })
          )
        }, 100)
        return worktree
      }
    })

    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    const prompt = composer.getByLabel('Prompt')
    await prompt.fill('Keep this prompt after the failure')
    await prompt.press('Enter')
    await expect(mockPage.getByText('Failed to create session')).toBeVisible()
    const restoredComposer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await expect(restoredComposer.getByLabel('Prompt')).toHaveValue(
      'Keep this prompt after the failure'
    )
    await expect(
      restoredComposer.getByRole('button', {
        name: /^Create worktree & start/,
      })
    ).toBeEnabled()
  })

  test('checks out a pull request and passes its complete context', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.evaluate(() => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
        ;(window as any).__PR_CREATE_ARGS__ = args
        const worktree = {
          id: 'pr-worktree',
          project_id: args.projectId,
          name: 'pr-worktree',
          path: '/tmp/e2e-test-project/.worktrees/pr-worktree',
          branch: 'feature/release-flow',
          created_at: Date.now() / 1000,
          order: 0,
          session_type: 'worktree',
          status: 'pending',
        }
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:created', {
              detail: {
                worktree: { ...worktree, status: 'ready' },
                autoOpenInJean: false,
              },
            })
          )
        }, 100)
        return worktree
      }
    })

    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'Pull request' }).click()
    const sourceBrowser = mockPage.getByRole('dialog', {
      name: 'Create from existing context',
    })
    await sourceBrowser
      .getByRole('button', { name: /#201.*release flow/i })
      .click()

    await expect(
      composer.getByRole('button', { name: 'Choose starting point' })
    ).toContainText('Pull request #201')
    await expect(
      composer.getByRole('button', { name: /^Check out PR/ })
    ).toBeVisible()
    const prComposerBounds = await composer.boundingBox()
    expect(prComposerBounds).not.toBeNull()
    expect(prComposerBounds?.height).toBeLessThan(320)
    await expect(
      composer.getByRole('button', { name: /base branch/i })
    ).toHaveCount(0)
    await composer.getByLabel('Prompt').fill('Review and finish this PR')
    await composer.getByLabel('Prompt').press('Enter')
    await expect(mockPage.getByText('Review and finish this PR')).toBeVisible({
      timeout: 10_000,
    })

    const args = await mockPage.evaluate(
      () => (window as any).__PR_CREATE_ARGS__
    )
    expect(args.baseBranch).toBeUndefined()
    expect(args.prContext).toMatchObject({
      number: 201,
      headRefName: 'feature/release-flow',
      baseRefName: 'main',
    })
  })

  test('continues on an existing branch through the dedicated command', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.evaluate(() => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      mock.invokeHandlers.create_worktree_from_existing_branch = (
        args: Record<string, unknown>
      ) => {
        ;(window as any).__EXISTING_BRANCH_ARGS__ = args
        const worktree = {
          id: 'existing-branch-worktree',
          project_id: args.projectId,
          name: 'feature-existing',
          path: '/tmp/e2e-test-project/.worktrees/feature-existing',
          branch: args.branchName,
          created_at: Date.now() / 1000,
          order: 0,
          session_type: 'worktree',
          status: 'pending',
        }
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:created', {
              detail: {
                worktree: { ...worktree, status: 'ready' },
                autoOpenInJean: false,
              },
            })
          )
        }, 100)
        return worktree
      }
    })

    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'Existing branch' }).click()
    await mockPage
      .getByRole('dialog', { name: 'Create from existing context' })
      .getByRole('button', { name: 'feature/existing' })
      .click()

    await expect(
      composer.getByRole('button', { name: 'Choose starting point' })
    ).toContainText('Existing branch')
    await composer.getByLabel('Prompt').fill('Continue this branch')
    await composer.getByLabel('Prompt').press('Enter')
    await expect(mockPage.getByText('Continue this branch')).toBeVisible({
      timeout: 10_000,
    })
    expect(
      await mockPage.evaluate(() => (window as any).__EXISTING_BRANCH_ARGS__)
    ).toMatchObject({ branchName: 'feature/existing' })
  })
})

test.describe('Prompt-first complete workflow matrix', () => {
  test.use({
    responseOverrides: {
      list_projects: [defaultProject, secondProject],
      list_github_issues: { issues: [issue], has_next_page: false },
      list_github_prs: [pullRequest],
      get_github_issue: { ...issue, comments: [] },
      get_github_pr: pullRequest,
      get_project_branches: ['main', 'develop', 'feature/existing'],
      get_jean_config: { scripts: { setup: null, run: [] } },
    },
  })

  test('submits a custom base branch and worktree name end to end', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'custom-options')
    const composer = await openPromptFirstComposer(mockPage)

    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: /Worktree options/i }).click()
    await composer.getByRole('button', { name: 'Base branch: main' }).click()
    await mockPage.getByRole('option', { name: /develop/i }).click()
    await composer
      .getByRole('button', { name: 'Worktree name: Automatic' })
      .click()
    await mockPage.getByPlaceholder('Automatic').fill('release-ready')
    await composer.getByLabel('Prompt').fill('Prepare the release branch')
    await composer.getByLabel('Prompt').press('Enter')

    await expect(mockPage.getByText('Prepare the release branch')).toBeVisible({
      timeout: 10_000,
    })
    const [args] = await mockPage.evaluate(
      () => (window as any).__WORKFLOW_CREATE_ARGS__
    )
    expect(args).toMatchObject({
      baseBranch: 'develop',
      customName: 'release-ready',
      autoOpenInJean: false,
    })
  })

  test('removes an attached issue and falls back to normal creation', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'cleared-source')
    const composer = await openPromptFirstComposer(mockPage)
    await composer.getByLabel('Prompt').fill('Create without issue context')
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'GitHub issue' }).click()
    await mockPage
      .getByRole('dialog', { name: 'Create from existing context' })
      .getByRole('button', { name: /#101.*onboarding/i })
      .click()
    await composer
      .getByRole('button', { name: 'Remove source context' })
      .click()
    await expect(composer.getByText('GitHub issue #101')).toHaveCount(0)
    await composer.getByLabel('Prompt').press('Enter')

    await expect(
      mockPage.getByText('Create without issue context')
    ).toBeVisible({
      timeout: 10_000,
    })
    const [args] = await mockPage.evaluate(
      () => (window as any).__WORKFLOW_CREATE_ARGS__
    )
    expect(args.issueContext).toBeUndefined()
    expect(args.baseBranch).toBe('main')
  })

  test('replaces issue context with a PR without losing the prompt', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'replace-source')
    const composer = await openPromptFirstComposer(mockPage)
    await composer.getByLabel('Prompt').fill('Keep this exact instruction')
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'GitHub issue' }).click()
    await mockPage
      .getByRole('dialog', { name: 'Create from existing context' })
      .getByRole('button', { name: /#101.*onboarding/i })
      .click()
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'Pull request' }).click()
    await mockPage
      .getByRole('dialog', { name: 'Create from existing context' })
      .getByRole('button', { name: /#201.*release flow/i })
      .click()

    await expect(composer.getByLabel('Prompt')).toHaveValue(
      'Keep this exact instruction'
    )
    await expect(composer.getByText('GitHub issue #101')).toHaveCount(0)
    await expect(
      composer.getByRole('button', { name: 'Choose starting point' })
    ).toContainText('Pull request #201')
    await composer.getByLabel('Prompt').press('Enter')
    await expect(mockPage.getByText('Keep this exact instruction')).toBeVisible(
      {
        timeout: 10_000,
      }
    )
    const [args] = await mockPage.evaluate(
      () => (window as any).__WORKFLOW_CREATE_ARGS__
    )
    expect(args.issueContext).toBeUndefined()
    expect(args.prContext.number).toBe(201)
  })

  test('creates two independent sessions consecutively with Create more', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'batch')
    const composer = await openPromptFirstComposer(mockPage)
    await composer.getByRole('switch', { name: 'Create more' }).click()

    await composer.getByLabel('Prompt').fill('First independent task')
    await composer.getByLabel('Prompt').press('Enter')
    await expect(composer.getByLabel('Prompt')).toHaveValue('', {
      timeout: 10_000,
    })
    await composer.getByLabel('Prompt').fill('Second independent task')
    await composer.getByLabel('Prompt').press('Enter')
    await expect(composer.getByLabel('Prompt')).toHaveValue('', {
      timeout: 10_000,
    })

    const calls = await mockPage.evaluate(
      () => (window as any).__WORKFLOW_CREATE_ARGS__
    )
    expect(calls).toHaveLength(2)
    await expect(composer).toBeVisible()
  })

  test('retries a failed dispatch and then completes the same prompt', async ({
    mockPage,
  }) => {
    await openPromptFirstComposer(mockPage)
    await mockPage.evaluate(() => {
      const win = window as any
      const mock = win.__JEAN_E2E_MOCK__
      mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
        const worktree = {
          id: 'retry-failed',
          project_id: args.projectId,
          name: 'retry-failed',
          path: '/tmp/e2e-test-project/.worktrees/retry-failed',
          branch: 'retry-failed',
          status: 'pending',
        }
        setTimeout(
          () =>
            mock.eventEmitter.dispatchEvent(
              new CustomEvent('worktree:error', {
                detail: { id: worktree.id, error: 'temporary failure' },
              })
            ),
          50
        )
        return worktree
      }
    })
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await composer.getByLabel('Prompt').fill('Retry me unchanged')
    await composer.getByLabel('Prompt').press('Enter')
    await expect(mockPage.getByText('Failed to create session')).toBeVisible()
    await installSuccessfulCreation(mockPage, 'retry-success')
    const restored = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await expect(restored.getByLabel('Prompt')).toHaveValue(
      'Retry me unchanged'
    )
    await restored.getByLabel('Prompt').press('Enter')

    await expect(mockPage.getByText('Retry me unchanged')).toBeVisible({
      timeout: 10_000,
    })
    expect(
      await mockPage.evaluate(
        () => (window as any).__WORKFLOW_CREATE_ARGS__.length
      )
    ).toBe(1)
  })

  test('creates for the project selected inside the composer', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'selected-project')
    const composer = await openPromptFirstComposer(mockPage)
    await composer.getByRole('button', { name: 'Choose project' }).click()
    await mockPage.getByRole('menuitem', { name: /Second Project/ }).click()
    await composer.getByLabel('Prompt').fill('Work in the selected project')
    await composer.getByLabel('Prompt').press('Enter')

    await expect(
      mockPage.getByText('Work in the selected project')
    ).toBeVisible({
      timeout: 10_000,
    })
    const [args] = await mockPage.evaluate(
      () => (window as any).__WORKFLOW_CREATE_ARGS__
    )
    expect(args).toMatchObject({
      projectId: 'project-second',
      baseBranch: 'develop',
    })
  })

  test('creates a worktree without a prompt and does not start an agent', async ({
    mockPage,
  }) => {
    await installSuccessfulCreation(mockPage, 'empty-prompt')
    const composer = await openPromptFirstComposer(mockPage)
    await mockPage.evaluate(() => {
      const win = window as any
      win.__EMPTY_PROMPT_SEND_COUNT__ = 0
      win.__JEAN_E2E_MOCK__.invokeHandlers.send_chat_message = () => {
        win.__EMPTY_PROMPT_SEND_COUNT__ += 1
      }
    })

    await composer
      .getByRole('button', { name: /^Create worktree\s*↵$/ })
      .click()

    await expect(composer).toBeHidden()
    await expect
      .poll(() =>
        mockPage.evaluate(() => (window as any).__WORKFLOW_CREATE_ARGS__.length)
      )
      .toBe(1)
    expect(
      await mockPage.evaluate(() => (window as any).__EMPTY_PROMPT_SEND_COUNT__)
    ).toBe(0)
  })

  test('starts a fresh conversation when the project folder already has history', async ({
    mockPage,
  }) => {
    const composer = await openPromptFirstComposer(mockPage)
    await mockPage.evaluate(() => {
      const win = window as any
      const mock = win.__JEAN_E2E_MOCK__
      const baseWorktree = {
        id: 'base-project-session',
        project_id: 'test-project',
        name: 'main',
        path: '/tmp/e2e-test-project',
        branch: 'main',
        created_at: Date.now() / 1000,
        order: 0,
        status: 'ready',
        session_type: 'base',
      }
      mock.invokeHandlers.create_base_session = () => baseWorktree
      mock.invokeHandlers.get_sessions = () => ({
        worktree_id: baseWorktree.id,
        sessions: [
          {
            id: 'historical-a',
            name: 'Historical A',
            order: 0,
            created_at: 1,
            messages: [],
          },
          {
            id: 'historical-b',
            name: 'Historical B',
            order: 1,
            created_at: 2,
            messages: [],
          },
        ],
        active_session_id: 'historical-a',
        version: 2,
      })
      mock.invokeHandlers.create_session = () => {
        win.__FRESH_BASE_SESSION_CREATED__ = true
        return {
          id: 'fresh-base-conversation',
          name: 'New Session',
          order: 2,
          created_at: Date.now() / 1000,
          messages: [],
        }
      }
      mock.invokeHandlers.set_session_model = (
        args: Record<string, unknown>
      ) => {
        win.__BASE_MODEL_SESSION_ID__ = args.sessionId
        return null
      }
    })

    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: /Project folder/i }).click()
    await expect(
      composer.getByRole('button', { name: /^Start in project folder/ })
    ).toBeVisible()
    await composer
      .getByLabel('Prompt')
      .fill('Start a clean conversation in the project folder')
    await composer.getByLabel('Prompt').press('Enter')

    await expect
      .poll(
        () =>
          mockPage.evaluate(() => ({
            created: (window as any).__FRESH_BASE_SESSION_CREATED__,
            configuredSession: (window as any).__BASE_MODEL_SESSION_ID__,
          })),
        { timeout: 10_000 }
      )
      .toEqual({
        created: true,
        configuredSession: 'fresh-base-conversation',
      })
  })

  test('returns from every source-browser close path with the draft intact', async ({
    mockPage,
  }) => {
    const composer = await openPromptFirstComposer(mockPage)
    await composer.getByLabel('Prompt').fill('Persistent navigation draft')

    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'GitHub issue' }).click()
    let browser = mockPage.getByRole('dialog', {
      name: 'Create from existing context',
    })
    await browser.getByRole('button', { name: 'Back to prompt' }).click()
    await expect(composer.getByLabel('Prompt')).toHaveValue(
      'Persistent navigation draft'
    )

    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'Pull request' }).click()
    browser = mockPage.getByRole('dialog', {
      name: 'Create from existing context',
    })
    await browser.getByRole('button', { name: 'Close' }).click()
    await expect(composer).toBeVisible()
    await expect(composer.getByLabel('Prompt')).toHaveValue(
      'Persistent navigation draft'
    )
  })
})

test.describe('Prompt-first project setup', () => {
  test.use({
    responseOverrides: {
      get_project_branches: ['main'],
      get_jean_config: {
        scripts: { setup: 'bun install', teardown: null, run: [] },
      },
    },
  })

  test('keeps the queued attachment visible while setup runs', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 30_000,
    })
    await mockPage.evaluate(() => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      mock.invokeHandlers.save_pasted_image = () => ({
        id: 'queued-setup-image',
        path: '/tmp/queued-during-setup.png',
        filename: 'queued-during-setup.png',
      })
      mock.invokeHandlers.send_chat_message = () => ({
        id: 'setup-response',
        role: 'assistant',
        content: 'Done',
      })
      const setupSession = {
        id: 'queued-attachment-session',
        name: 'Session 1',
        order: 0,
        created_at: Date.now() / 1000,
        messages: [],
        backend: 'claude',
      }
      mock.invokeHandlers.get_sessions = () => ({
        sessions: [setupSession],
        active_session_id: setupSession.id,
      })
      mock.invokeHandlers.get_session = () => setupSession
      mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
        const worktree = {
          id: 'queued-attachment-worktree',
          project_id: args.projectId,
          name: 'queued-attachment-worktree',
          path: '/tmp/e2e-test-project/.worktrees/queued-attachment-worktree',
          branch: 'queued-attachment-worktree',
          created_at: Date.now() / 1000,
          order: 0,
          session_type: 'worktree',
          status: 'pending',
          setup_script: 'bun install',
          setup_success: null,
        }
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:created', {
              detail: {
                worktree: { ...worktree, status: 'ready' },
                autoOpenInJean: false,
              },
            })
          )
        }, 100)
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent('open-worktree-modal', {
              detail: {
                worktreeId: worktree.id,
                worktreePath: worktree.path,
              },
            })
          )
        }, 300)
        return worktree
      }
    })

    const composer = await openPromptFirstComposer(mockPage)
    await composer.getByLabel('Prompt').fill('Fix it with this screenshot')
    await composer.locator('input[type="file"]').setInputFiles({
      name: 'setup-proof.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not-a-real-png'),
    })
    await composer.getByLabel('Prompt').press('Enter')

    const setupProgress = mockPage.getByRole('region', {
      name: 'Worktree setup in progress',
    })
    await expect(setupProgress).toBeVisible()
    await expect(
      setupProgress.getByText('Fix it with this screenshot')
    ).toBeVisible()
    await expect(
      setupProgress.getByAltText('queued-during-setup.png')
    ).toBeVisible()
    await expect(
      setupProgress.getByText('Queued until setup finishes')
    ).toBeVisible()
  })

  test('waits for setup completion before starting the prompt', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.evaluate(() => {
      const mock = (window as any).__JEAN_E2E_MOCK__
      ;(window as any).__SETUP_PROMPT_SEND_ARGS__ = []
      mock.invokeHandlers.send_chat_message = (
        args: Record<string, unknown>
      ) => {
        ;(window as any).__SETUP_PROMPT_SEND_ARGS__.push(args)
        return { id: 'setup-response', role: 'assistant', content: 'Done' }
      }
      mock.invokeHandlers.create_worktree = (args: Record<string, unknown>) => {
        const worktree = {
          id: 'setup-worktree',
          project_id: args.projectId,
          name: 'setup-worktree',
          path: '/tmp/e2e-test-project/.worktrees/setup-worktree',
          branch: 'setup-worktree',
          created_at: Date.now() / 1000,
          order: 0,
          session_type: 'worktree',
          status: 'pending',
        }
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:created', {
              detail: {
                worktree: { ...worktree, status: 'ready' },
                autoOpenInJean: false,
              },
            })
          )
        }, 100)
        setTimeout(() => {
          mock.eventEmitter.dispatchEvent(
            new CustomEvent('worktree:setup_complete', {
              detail: {
                id: worktree.id,
                project_id: args.projectId,
                setup_output: 'Installed',
                setup_script: 'bun install',
                setup_success: true,
              },
            })
          )
        }, 3_000)
        return worktree
      }
    })

    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await expect(composer.getByText('Setup before prompt')).toHaveCount(0)
    await composer.getByRole('switch', { name: 'Create more' }).click()
    await composer.getByLabel('Prompt').fill('Start after dependencies exist')
    await composer.getByLabel('Prompt').press('Enter')
    await expect(composer).toBeVisible()
    await mockPage.waitForTimeout(300)
    await expect(composer.getByLabel('Prompt')).toHaveValue('')
    await expect(
      composer.getByRole('button', { name: /^Create worktree\s*↵$/ })
    ).toBeEnabled()
    expect(
      await mockPage.evaluate(
        () => (window as any).__SETUP_PROMPT_SEND_ARGS__.length
      )
    ).toBe(0)
    await composer.getByLabel('Prompt').fill('Prepare another worktree')
    await expect
      .poll(() =>
        mockPage.evaluate(
          () => (window as any).__SETUP_PROMPT_SEND_ARGS__.length
        )
      )
      .toBe(1)
    expect(
      await mockPage.evaluate(
        () => (window as any).__SETUP_PROMPT_SEND_ARGS__[0].message
      )
    ).toBe('Start after dependencies exist')
  })
})

test.describe('Prompt-first mobile layout', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    responseOverrides: {
      list_github_issues: { issues: [issue], has_next_page: false },
      get_project_branches: ['main'],
      get_jean_config: {
        scripts: { setup: null, teardown: null, run: [] },
      },
    },
  })

  test('keeps the prompt while navigating the full-screen source picker', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })
    await mockPage.getByRole('button', { name: 'Project actions' }).click()
    await mockPage.getByRole('menuitem', { name: 'New Worktree' }).click()
    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    const box = await composer.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(382)
    expect(box!.height).toBeLessThan(420)

    const modelPicker = composer.getByRole('button', {
      name: 'Choose backend and model',
    })
    await expect(modelPicker).toBeVisible()
    await expect(
      composer.getByRole('button', { name: 'Create worktree', exact: true })
    ).toBeVisible()
    await modelPicker.click()
    await expect(
      mockPage.getByRole('heading', { name: 'Select Backend & Model' })
    ).toBeVisible()
    await mockPage.keyboard.press('Escape')

    await composer.getByLabel('Prompt').fill('Mobile prompt draft')
    await composer
      .getByRole('button', { name: 'Choose starting point' })
      .click()
    await mockPage.getByRole('menuitem', { name: 'GitHub issue' }).click()
    const sourceBrowser = mockPage.getByRole('dialog', {
      name: 'Create from existing context',
    })
    await expect(sourceBrowser).toBeVisible()
    await sourceBrowser.getByRole('button', { name: 'Back to prompt' }).click()

    await expect(composer.getByLabel('Prompt')).toHaveValue(
      'Mobile prompt draft'
    )
  })

  test('closes the sidebar before opening the prompt composer', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 15_000,
    })

    await mockPage.keyboard.press('Control+B')
    const sidebar = mockPage.getByTestId('mobile-left-sidebar')
    await expect(sidebar).toBeVisible()
    await sidebar.getByRole('button', { name: 'New worktree' }).click()

    const composer = mockPage.getByRole('dialog', {
      name: 'Start something new',
    })
    await expect(sidebar).toBeHidden()
    await expect(composer).toBeVisible()
  })
})
