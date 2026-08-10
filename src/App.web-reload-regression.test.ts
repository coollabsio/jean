import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web reload recovery UI', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('reloads the web app after an established websocket disconnects', () => {
    expect(source).toContain(
      "logger.info('WebSocket disconnected, reloading web app')"
    )
    expect(source).toContain('onEstablishedWsDisconnect(() =>')
    expect(source).toMatch(
      /captureWebReloadState\(\)[\s\S]*?window\.location\.reload\(\)/
    )
    expect(source).toContain('<JeanLoadingScreen />')
    // Preload path may also mount QuitConfirmationDialog so X/quit still works
    expect(source).toContain('QuitConfirmationDialog')
    expect(source).not.toContain('WebReloadingOverlay')
  })

  it('dismisses stuck overlays on native remote disconnect instead of reloading', () => {
    // Native remote keeps the shell + recovery UI; pure web still reloads.
    expect(source).toContain('dismissTransientUi()')
    expect(source).toMatch(/if \(isNativeApp\(\)\) \{\s*dismissTransientUi\(\)/)
    // Must not skip the disconnect listener entirely for native clients.
    expect(source).not.toMatch(/if \(!webBackend \|\| isNativeApp\(\)\) return/)
  })
})
