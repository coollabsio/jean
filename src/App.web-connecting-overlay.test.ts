import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web connecting overlay', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('uses the same opaque theme background as initial loading', () => {
    expect(source).toContain('webBackend && !wsConnected && !wsAuthError')
    expect(source).toContain(
      'fixed inset-0 z-[70] flex items-center justify-center bg-background'
    )
    expect(source).not.toContain('backdrop-blur-md')
    expect(source).not.toContain('bg-background/20')
    expect(source).toContain('z-[70]')
    expect(source).toContain('fixed inset-0 z-[80]')
  })

  it('uses the same centered loading layout for opening and reconnecting', () => {
    expect(source).toContain('function WebLoadingScreen({ label }')
    expect(
      source.match(/<WebLoadingScreen label="Loading Jean\.\.\." \/>/g)
    ).toHaveLength(2)
    expect(source).not.toContain('Jean is loading...')
    expect(source).not.toContain('Reconnecting to Jean...')
    expect(source).not.toContain('animate-spin')
    expect(source).not.toContain('size-[32px]')
    expect(source).toMatch(/<p\s+role="status"/)
    expect(source).toContain('fixed inset-0 z-[70]')
    expect(source).not.toContain('h-screen w-full')
  })

  it('uses a stable system font while preferences load', () => {
    expect(source).toContain(
      'fontFamily: \'system-ui, -apple-system, "Segoe UI", sans-serif\''
    )
  })

  it('loads the server platform for both local and remote backends', () => {
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*invoke<'mac' \| 'windows' \| 'linux'>\('get_server_platform'\)/
    )
  })
})
