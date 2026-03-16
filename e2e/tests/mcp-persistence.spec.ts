import { test as base, expect, type Page } from '@playwright/test'
import { defaultResponses } from '../fixtures/invoke-handlers'
import { activateWorktree } from '../fixtures/tauri-mock'

const mockMcpServers = [
  { name: 'test-server-1', scope: 'user', disabled: false, config: {} },
  { name: 'test-server-2', scope: 'project', disabled: false, config: {} },
]

/**
 * Extended fixture with a stateful session store that persists across
 * simulated reloads. update_session_state writes enabled_mcp_servers
 * into the store so get_session returns it after reload.
 */
const test = base.extend<{ mockPage: Page }>({
  mockPage: async ({ page, baseURL }, use) => {
    const responses: Record<string, unknown> = {
      ...defaultResponses,
      get_mcp_servers: mockMcpServers,
      check_mcp_health: { statuses: {} },
    }

    // Persist session state across navigations via sessionStorage.
    await page.addInitScript(
      ({ responseMap }: { responseMap: Record<string, unknown> }) => {
        // Restore persisted session store from sessionStorage (survives reload)
        const saved = sessionStorage.getItem('__e2e_session_store__')
        const sessionStore: Record<
          string,
          {
            sessions: Array<Record<string, unknown>>
            active_session_id: string | null
          }
        > = saved ? JSON.parse(saved) : {}

        function getWorktreeStore(worktreeId: string) {
          if (!sessionStore[worktreeId]) {
            sessionStore[worktreeId] = {
              sessions: [],
              active_session_id: null,
            }
          }
          return sessionStore[worktreeId]
        }

        function persistStore() {
          sessionStorage.setItem(
            '__e2e_session_store__',
            JSON.stringify(sessionStore)
          )
        }

        // Track update_session_state calls for assertions
        ;(window as any).__updateSessionStateCalls = []

        const dynamicHandlers: Record<
          string,
          (args?: Record<string, unknown>) => unknown
        > = {
          get_sessions: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            return {
              worktree_id: wid,
              sessions: store.sessions,
              active_session_id: store.active_session_id,
              version: 2,
            }
          },
          create_session: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            const name =
              (args?.name as string) || `Session ${store.sessions.length + 1}`
            const session = {
              id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              name,
              order: store.sessions.length,
              created_at: Date.now() / 1000,
              messages: [],
            }
            store.sessions.unshift(session)
            store.active_session_id = session.id
            persistStore()
            return session
          },
          set_active_session: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            store.active_session_id = (args?.sessionId as string) ?? null
            persistStore()
            return null
          },
          get_session: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            const session = store.sessions.find(s => s.id === args?.sessionId)
            return session
              ? structuredClone(session)
              : {
                  id: args?.sessionId ?? 'unknown',
                  name: 'Session',
                  order: 0,
                  created_at: Date.now() / 1000,
                  messages: [],
                }
          },
          rename_session: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            const session = store.sessions.find(s => s.id === args?.sessionId)
            if (session) session.name = args?.newName as string
            persistStore()
            return null
          },
          update_session_state: args => {
            // Record for test assertions
            ;(window as any).__updateSessionStateCalls.push(
              structuredClone(args)
            )
            // Persist enabled_mcp_servers into the session store
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            const session = store.sessions.find(s => s.id === args?.sessionId)
            if (session && args?.enabledMcpServers !== undefined) {
              session.enabled_mcp_servers = args.enabledMcpServers
            }
            persistStore()
            return null
          },
        }

        const handlers: Record<string, (args?: any) => unknown> = {}
        for (const [cmd, data] of Object.entries(responseMap)) {
          if (dynamicHandlers[cmd]) {
            handlers[cmd] = dynamicHandlers[cmd]
          } else {
            handlers[cmd] = () => structuredClone(data)
          }
        }
        for (const [cmd, handler] of Object.entries(dynamicHandlers)) {
          if (!handlers[cmd]) handlers[cmd] = handler
        }

        ;(window as any).__JEAN_E2E_MOCK__ = {
          invokeHandlers: handlers,
          eventEmitter: new EventTarget(),
        }
      },
      { responseMap: responses }
    )

    await page.goto(baseURL ?? 'http://localhost:1421')
    await use(page)
  },
})

test.describe('MCP Server Session Persistence', () => {
  test('toggled MCP server is saved via update_session_state', async ({
    mockPage,
  }) => {
    // Navigate to a worktree and create a session
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })
    await activateWorktree(mockPage, 'fuzzy-tiger')
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    // Widen viewport so MCP button is visible
    await mockPage.setViewportSize({ width: 1280, height: 720 })
    await mockPage.waitForTimeout(1000)

    // Open MCP dropdown and verify both servers are visible
    const mcpButton = mockPage.locator('button:has(svg.lucide-plug)')
    await expect(mcpButton).toBeVisible({ timeout: 3000 })
    await mcpButton.click()

    const server1 = mockPage.locator(
      '[role="menuitemcheckbox"]:has-text("test-server-1")'
    )
    await expect(server1).toBeVisible({ timeout: 5000 })

    // Toggle test-server-1 off
    await server1.click()
    await mockPage.waitForTimeout(300)

    // Close dropdown
    await mockPage.keyboard.press('Escape')
    await mockPage.waitForTimeout(300)

    // Wait for debounced save (500ms + margin)
    await mockPage.waitForTimeout(1000)

    // Verify update_session_state was called with enabledMcpServers
    const calls = await mockPage.evaluate(
      () => (window as any).__updateSessionStateCalls
    )
    expect(calls.length).toBeGreaterThan(0)
    const mcpCall = calls.find((c: any) => c.enabledMcpServers !== undefined)
    expect(mcpCall).toBeDefined()
    expect(Array.isArray(mcpCall.enabledMcpServers)).toBe(true)

    // test-server-1 was toggled off, so it should NOT be in the saved list
    expect(mcpCall.enabledMcpServers).not.toContain('test-server-1')
    // test-server-2 should still be enabled
    expect(mcpCall.enabledMcpServers).toContain('test-server-2')
  })

  test('MCP server state persists in session store across reload', async ({
    mockPage,
  }) => {
    // Navigate to a worktree and create a session
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })
    await activateWorktree(mockPage, 'fuzzy-tiger')
    await mockPage.locator('button[aria-label="New session"]').click()
    await mockPage.waitForTimeout(500)

    // Widen viewport so MCP button is visible
    await mockPage.setViewportSize({ width: 1280, height: 720 })
    await mockPage.waitForTimeout(1000)

    // Open MCP dropdown, toggle test-server-1 off
    const mcpButton = mockPage.locator('button:has(svg.lucide-plug)')
    await expect(mcpButton).toBeVisible({ timeout: 3000 })
    await mcpButton.click()

    const server1 = mockPage.locator(
      '[role="menuitemcheckbox"]:has-text("test-server-1")'
    )
    await expect(server1).toBeVisible({ timeout: 5000 })
    await server1.click()
    await mockPage.waitForTimeout(300)
    await mockPage.keyboard.press('Escape')

    // Wait for debounced save
    await mockPage.waitForTimeout(1500)

    // --- RELOAD ---
    await mockPage.reload()
    await mockPage.waitForTimeout(1000)

    // After reload, verify the session store in sessionStorage preserved
    // the enabled_mcp_servers field
    const storeAfterReload = await mockPage.evaluate(() => {
      const saved = sessionStorage.getItem('__e2e_session_store__')
      return saved ? JSON.parse(saved) : {}
    })

    // Find the worktree store that has sessions
    const worktreeStores = Object.values(storeAfterReload) as Array<{
      sessions: Array<Record<string, unknown>>
      active_session_id: string | null
    }>
    const storeWithSessions = worktreeStores.find(s => s.sessions.length > 0)
    expect(storeWithSessions).toBeDefined()

    // The session should have enabled_mcp_servers persisted
    const session = storeWithSessions!.sessions[0]
    expect(session.enabled_mcp_servers).toBeDefined()
    expect(session.enabled_mcp_servers).not.toContain('test-server-1')
    expect(session.enabled_mcp_servers).toContain('test-server-2')

    // Verify active_session_id was also persisted
    expect(storeWithSessions!.active_session_id).toBe(session.id)
  })
})
