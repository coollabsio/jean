import { test, expect } from '../fixtures/tauri-mock'

const cases = (
  ['native desktop', 'web desktop', 'mobile web'] as const
).flatMap(mode =>
  (['global', 'project'] as const).map(surface => ({ mode, surface }))
)

for (const { mode, surface } of cases) {
  test.describe(`MCP sign-in (${mode}, ${surface})`, () => {
    test.use({
      viewport:
        mode === 'mobile web'
          ? { width: 390, height: 844 }
          : { width: 1440, height: 900 },
      responseOverrides: {
        get_package_scripts: [],
        get_run_scripts: [],
        list_pending_wakeups: [],
        get_mcp_servers: [
          {
            name: 'orbit-dev',
            scope: 'user',
            disabled: false,
            config: { type: 'http', url: 'https://example.com/mcp' },
            backend: 'claude',
          },
        ],
        check_mcp_health: { statuses: { 'orbit-dev': 'needsAuthentication' } },
        prepare_mcp_login: {
          command: '/managed/claude',
          commandArgs: ['mcp', 'login', '--no-browser', 'orbit-dev'],
          worktreePath: '/repo',
        },
        start_terminal: null,
        stop_terminal: true,
        terminal_resize: null,
        terminal_write: null,
      },
    })

    test('opens the selected MCP login and refreshes status after completion', async ({
      mockPage,
      emitEvent,
    }) => {
      await expect(mockPage.getByText('Test Project')).toBeVisible()
      await mockPage.evaluate(native => {
        const w = window as unknown as {
          __JEAN_E2E_MOCK__: {
            invokeHandlers: Record<
              string,
              (args?: Record<string, unknown>) => unknown
            >
          }
          __TAURI_INTERNALS__?: {
            invoke: (
              command: string,
              args?: Record<string, unknown>
            ) => Promise<unknown>
          }
          __mcpStarted?: Record<string, unknown>
        }
        const handlers = w.__JEAN_E2E_MOCK__.invokeHandlers
        handlers.update_project_settings = () =>
          (handlers.list_projects?.() as unknown[])?.[0]
        handlers.start_terminal = args => {
          w.__mcpStarted = args
          return null
        }
        if (native) {
          w.__TAURI_INTERNALS__ = {
            invoke: async (command, args) => {
              const name =
                command === 'dispatch_core_command'
                  ? (args?.command as string)
                  : command
              const payload =
                command === 'dispatch_core_command'
                  ? (args?.args as Record<string, unknown>)
                  : args
              return handlers[name]?.(payload) ?? null
            },
          }
        }
      }, mode === 'native desktop')

      if (surface === 'project') {
        await mockPage
          .getByRole('button', { name: 'Project actions', exact: true })
          .click()
        await mockPage
          .getByRole('menuitem', { name: 'Project Settings', exact: true })
          .click()
      } else {
        const openSettings = mockPage.getByRole('button', {
          name: 'Open Settings',
          exact: true,
        })
        if (!(await openSettings.isVisible())) {
          await mockPage.locator('button').first().click()
        }
        await openSettings.click()
      }
      const settings = mockPage.getByRole('dialog', {
        name:
          surface === 'project'
            ? 'Project Settings — Test Project'
            : 'Settings',
        exact: true,
      })
      await expect(settings).toBeVisible()
      if (mode === 'mobile web') {
        await settings.locator('header').getByRole('combobox').click()
        await mockPage
          .getByRole('option', { name: 'MCP Servers', exact: true })
          .click()
      } else {
        await settings
          .getByRole('button', { name: 'MCP Servers', exact: true })
          .click()
      }
      await mockPage
        .getByRole('button', { name: 'Sign in to orbit-dev' })
        .click()
      const login = mockPage
        .getByRole('dialog')
        .filter({ hasText: 'orbit-dev — MCP sign-in' })
      await expect(login).toBeVisible()
      await expect
        .poll(() =>
          mockPage.evaluate(
            () =>
              (window as unknown as { __mcpStarted?: Record<string, unknown> })
                .__mcpStarted?.commandArgs
          )
        )
        .toEqual(['mcp', 'login', '--no-browser', 'orbit-dev'])
      const terminal = login.getByTestId('standalone-terminal-surface')
      const terminalId = await terminal.getAttribute('data-terminal-id')
      if (mode !== 'native desktop') {
        await login
          .getByRole('textbox', { name: 'Login code or URL' })
          .fill('http://localhost/callback?code=test&state=test')
        await login.getByRole('button', { name: 'Send', exact: true }).click()
      }
      await mockPage.evaluate(() => {
        const mock = (
          window as unknown as {
            __JEAN_E2E_MOCK__: { invokeHandlers: Record<string, () => unknown> }
          }
        ).__JEAN_E2E_MOCK__
        mock.invokeHandlers.check_mcp_health = () => ({
          statuses: { 'orbit-dev': 'connected' },
        })
      })
      await emitEvent('terminal:stopped', {
        terminal_id: terminalId,
        exit_code: 0,
        signal: null,
      })
      await expect(login).not.toBeVisible({ timeout: 5000 })
      if (surface === 'project') {
        await expect(
          settings.getByRole('img', { name: 'Connected', exact: true })
        ).toBeVisible()
      } else {
        await expect(
          settings.getByText('connected', { exact: true })
        ).toBeVisible()
      }
      await expect(
        settings.getByRole('button', { name: 'Sign in to orbit-dev' })
      ).not.toBeVisible()
    })
  })
}
