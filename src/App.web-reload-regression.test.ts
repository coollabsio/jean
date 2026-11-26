import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web disconnect recovery UI', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('reconnects and resyncs in memory after an established websocket disconnects', () => {
    const recovery = source.slice(
      source.indexOf('onWsRecovery({'),
      source.indexOf('}, [captureWebReloadState, queryClient, webBackend])')
    )
    expect(recovery).toMatch(
      /disconnected: \(\) => \{[\s\S]*?setWebReconnecting\(true\)/
    )
    // The overlay stays until the page caught up, and through a second drop.
    expect(recovery).toMatch(
      /await resyncAfterReconnect\(queryClient\)[\s\S]*?if \(isTransportConnected\(\)\) setWebReconnecting\(false\)/
    )
    // Only a restarted or updated server still reloads the page.
    expect(recovery.match(/window\.location\.reload\(\)/g)).toHaveLength(1)
    expect(recovery).toMatch(
      /reloadRequired: \(\) => \{[\s\S]*?captureWebReloadState\(\)\s*window\.location\.reload\(\)/
    )
    expect(source).toContain('<JeanLoadingScreen')
    // Preload path may also mount QuitConfirmationDialog so X/quit still works
    expect(source).toContain('QuitConfirmationDialog')
    expect(source).not.toContain('WebReloadingOverlay')
  })

  it('dismisses stuck overlays on native remote disconnect instead of reloading', () => {
    // Native remote keeps the shell + recovery UI; pure web reconnects.
    expect(source).toContain('dismissTransientUi()')
    expect(source).toMatch(/if \(isNativeApp\(\)\) \{\s*dismissTransientUi\(\)/)
    // Must not skip the disconnect listener entirely for native clients.
    expect(source).not.toMatch(/if \(!webBackend \|\| isNativeApp\(\)\) return/)
  })
})
