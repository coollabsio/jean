import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression: #530 — Jean ignored window X/quit while "Loading Jean..." was
 * shown (boot or server switch). Close handling must live at App root so it
 * stays active when MainWindow is unmounted, and must destroy() after a sync
 * preventDefault so Windows cannot silently drop the close.
 */
describe('window close during loading (#530)', () => {
  const appSource = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')
  const guardSource = readFileSync(
    `${process.cwd()}/src/hooks/useNativeWindowCloseGuard.ts`,
    'utf8'
  )
  const windowCloseSource = readFileSync(
    `${process.cwd()}/src/lib/window-close.ts`,
    'utf8'
  )
  const transportSource = readFileSync(
    `${process.cwd()}/src/lib/transport.ts`,
    'utf8'
  )
  const windowCommandsSource = readFileSync(
    `${process.cwd()}/src/lib/commands/window-commands.ts`,
    'utf8'
  )

  it('registers the native close guard at App root', () => {
    expect(appSource).toContain('useNativeWindowCloseGuard')
    expect(appSource).toMatch(/useNativeWindowCloseGuard\(\)/)
  })

  it('keeps quit confirmation mounted during preloading', () => {
    expect(appSource).toContain('isPreloading')
    expect(appSource).toMatch(
      /if \(isPreloading\) \{[\s\S]*?<QuitConfirmationDialog \/>/
    )
  })

  it('uses sync preventDefault and destroy for close handling', () => {
    expect(guardSource).toContain('event.preventDefault()')
    expect(guardSource).toContain('destroyAppWindow')
    expect(guardSource).toContain('checkHasRunningSessions')
    // Inside the close callback, preventDefault must run before awaited work.
    const callbackStart = guardSource.indexOf('async event => {')
    expect(callbackStart).toBeGreaterThan(-1)
    const callback = guardSource.slice(callbackStart, callbackStart + 500)
    const preventIdx = callback.indexOf('event.preventDefault()')
    const firstAwaitedCall = callback.indexOf('await checkHasRunningSessions')
    expect(preventIdx).toBeGreaterThan(-1)
    expect(firstAwaitedCall).toBeGreaterThan(preventIdx)
  })

  it('skips the session check when no backend is available', () => {
    expect(windowCloseSource).toContain(
      'if (!isNativeApp() && !hasBackend()) return false'
    )
    expect(windowCloseSource).toContain('SESSION_CHECK_TIMEOUT_MS')
  })

  it('routes has_running_sessions through the local shell when native', () => {
    expect(transportSource).toContain("'has_running_sessions'")
    expect(transportSource).toContain('LOCAL_SHELL_COMMANDS')
  })

  it('window-close command uses destroy-based requestAppQuit', () => {
    expect(windowCommandsSource).toContain('requestAppQuit')
    expect(windowCommandsSource).not.toMatch(
      /window-close[\s\S]*?appWindow\.close\(\)/
    )
  })
})
