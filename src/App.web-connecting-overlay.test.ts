import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web connecting overlay', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')
  const loadingScreenSource = readFileSync(
    `${process.cwd()}/src/components/shared/JeanLoadingScreen.tsx`,
    'utf8'
  )

  it('uses the same opaque theme background as initial loading', () => {
    // Single loading gate: preload OR (WS not ready without preloaded data)
    expect(source).toContain(
      '!wsConnected && !wsAuthError && !hasPreloadedData()'
    )
    expect(loadingScreenSource).toContain(
      'fixed inset-0 z-[70] flex items-center justify-center bg-background'
    )
    expect(loadingScreenSource).not.toContain('backdrop-blur-md')
    expect(loadingScreenSource).not.toContain('bg-background/20')
    expect(loadingScreenSource).toContain('z-[70]')
    expect(source).toContain('fixed inset-0 z-[80]')
  })

  it('uses the same centered loading layout for opening and reconnecting', () => {
    expect(source).toContain(
      "import { JeanLoadingScreen } from './components/shared/JeanLoadingScreen'"
    )
    // One loading screen path (preload and WS-fallback share it) — no stacked phases
    expect(source.match(/<JeanLoadingScreen \/>/g)).toHaveLength(1)
    expect(source).toContain('connectTransport()')
    expect(source).toContain('blockOnWs')
    expect(source).not.toContain('Jean is loading...')
    expect(source).not.toContain('Reconnecting to Jean...')
    expect(loadingScreenSource).not.toContain('animate-spin')
    expect(loadingScreenSource).not.toContain('size-[32px]')
    expect(loadingScreenSource).toMatch(/<p\s+role="status"/)
    expect(loadingScreenSource).toContain('fixed inset-0 z-[70]')
    expect(loadingScreenSource).not.toContain('h-screen w-full')
  })

  it('uses a stable system font while preferences load', () => {
    expect(loadingScreenSource).toContain(
      'fontFamily: \'system-ui, -apple-system, "Segoe UI", sans-serif\''
    )
  })

  it('loads the server platform for both local and remote backends', () => {
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*invoke<'mac' \| 'windows' \| 'linux'>\('get_server_platform'\)/
    )
  })
})
