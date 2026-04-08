/**
 * Playwright test fixture that injects E2E mock transport.
 * Usage: import { test, expect } from '../fixtures/tauri-mock'
 */

import { test as base, expect, type Page } from '@playwright/test'
import { defaultResponses } from './invoke-handlers'

interface TauriMockFixtures {
  /** Page with Tauri mocks injected. Navigates to '/' automatically. */
  mockPage: Page
  /** Override specific command responses for this test. */
  responseOverrides: Record<string, unknown>
  /** Emit a backend event to the app (simulates Rust → React events). */
  emitEvent: (event: string, payload: unknown) => Promise<void>
}

export const test = base.extend<TauriMockFixtures>({
  // Default: no overrides. Tests can set this via test.use({})
  responseOverrides: [{}, { option: true }],

  mockPage: async ({ page, responseOverrides }, use) => {
    const responses = { ...defaultResponses, ...responseOverrides }

    // Keys explicitly overridden — these take precedence over dynamic handlers
    const overrideKeys = Object.keys(responseOverrides)

    await page.addInitScript(
      ({
        responseMap,
        overrideKeys,
      }: {
        responseMap: Record<string, unknown>
        overrideKeys: string[]
      }) => {
        const overrideSet = new Set(overrideKeys)

        // In-memory session store for stateful handlers
        const sessionStore: Record<
          string,
          {
            sessions: Array<Record<string, unknown>>
            active_session_id: string | null
          }
        > = {}

        function getWorktreeStore(worktreeId: string) {
          if (!sessionStore[worktreeId]) {
            sessionStore[worktreeId] = {
              sessions: [],
              active_session_id: null,
            }
          }
          return sessionStore[worktreeId]
        }

        function findSession(sessionId?: unknown) {
          if (typeof sessionId !== 'string' || !sessionId) return null
          for (const store of Object.values(sessionStore)) {
            const session = store.sessions.find(s => s.id === sessionId)
            if (session) return session
          }
          return null
        }

        // Commands that need dynamic responses based on args
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
            return session
          },
          rename_session: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            const session = store.sessions.find(s => s.id === args?.sessionId)
            if (session) {
              session.name = args?.newName as string
            }
            return null
          },
          set_active_session: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            store.active_session_id = (args?.sessionId as string) ?? null
            return null
          },
          set_session_model: args => {
            const wid = (args?.worktreeId as string) ?? 'unknown'
            const store = getWorktreeStore(wid)
            const session = store.sessions.find(s => s.id === args?.sessionId)
            if (session) {
              session.selected_model = args?.model as string
            }
            return null
          },
          get_session: args => {
            const session =
              findSession(args?.sessionId) ??
              (() => {
                const wid = (args?.worktreeId as string) ?? 'unknown'
                const store = getWorktreeStore(wid)
                return (
                  store.sessions.find(s => s.id === args?.sessionId) ?? null
                )
              })()
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
          get_revert_targets: args => {
            const session = findSession(args?.sessionId)
            return structuredClone(
              (session as { revert_targets?: unknown[] } | null)
                ?.revert_targets ?? []
            )
          },
          send_chat_message: args => {
            // Return a mock assistant ChatMessage
            // Actual streaming is handled via emitEvent
            return {
              id: `msg-${Date.now()}`,
              session_id: args?.sessionId ?? 'unknown',
              role: 'assistant',
              content: 'Mock response',
              content_blocks: [{ type: 'text', text: 'Mock response' }],
              timestamp: Math.floor(Date.now() / 1000),
              cost_usd: 0.001,
              duration_ms: 500,
              model: 'sonnet',
              tool_calls: [],
              cancelled: false,
            }
          },
          revert_to_message: args => {
            const session = findSession(args?.sessionId) as {
              messages?: Array<{ id?: string }>
              revert_targets?: Array<{ userMessageId?: string }>
              updated_at?: number
            } | null
            if (!session) return null

            const userMessageId = args?.userMessageId as string | undefined
            if (userMessageId && Array.isArray(session.messages)) {
              const targetIndex = session.messages.findIndex(
                message => message.id === userMessageId
              )
              if (targetIndex >= 0) {
                session.messages = session.messages.slice(0, targetIndex)
              }
            }

            if (userMessageId && Array.isArray(session.revert_targets)) {
              const targetIndex = session.revert_targets.findIndex(
                target => target.userMessageId === userMessageId
              )
              if (targetIndex >= 0) {
                session.revert_targets = session.revert_targets.slice(
                  0,
                  targetIndex
                )
              }
            }

            session.updated_at = Date.now() / 1000
            return null
          },
        }

        const handlers: Record<string, (args?: any) => unknown> = {}

        for (const [cmd, data] of Object.entries(responseMap)) {
          // If explicitly overridden, use static response (override wins over dynamic)
          if (overrideSet.has(cmd)) {
            handlers[cmd] = () => structuredClone(data)
          } else if (dynamicHandlers[cmd]) {
            handlers[cmd] = dynamicHandlers[cmd]
          } else {
            handlers[cmd] = () => structuredClone(data)
          }
        }

        // Also add dynamic handlers that aren't in the response map
        for (const [cmd, handler] of Object.entries(dynamicHandlers)) {
          if (!handlers[cmd]) {
            handlers[cmd] = handler
          }
        }

        ;(window as any).__JEAN_E2E_MOCK__ = {
          invokeHandlers: handlers,
          eventEmitter: new EventTarget(),
          sessionStore,
        }
      },
      { responseMap: responses, overrideKeys }
    )

    await page.goto('/')
    await use(page)
  },

  emitEvent: async ({ mockPage }, use) => {
    const emitFn = async (event: string, payload: unknown) => {
      await mockPage.evaluate(
        ({ event, payload }) => {
          const emitter = (window as any).__JEAN_E2E_MOCK__?.eventEmitter
          if (emitter) {
            emitter.dispatchEvent(new CustomEvent(event, { detail: payload }))
          }
        },
        { event, payload }
      )
    }
    await use(emitFn)
  },
})

export { expect }

/**
 * Helper: open sidebar and click a worktree to activate it.
 * Waits for the chat view to appear.
 */
export async function activateWorktree(
  page: Page,
  worktreeName: string
): Promise<void> {
  // Ensure sidebar is visible
  const projectsHeader = page.getByText('PROJECTS')
  if (!(await projectsHeader.isVisible().catch(() => false))) {
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(500)
  }
  await expect(projectsHeader).toBeVisible({ timeout: 3000 })

  // Click the worktree
  await page.getByText(worktreeName).click()
  await page.waitForTimeout(1000)

  // Wait for chat view (dashboard empty state should be gone)
  await expect(
    page.getByText('Your imagination is the only limit')
  ).not.toBeVisible({ timeout: 3000 })
}
