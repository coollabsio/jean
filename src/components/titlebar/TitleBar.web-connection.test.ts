import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web connection header', () => {
  const source = readFileSync(
    `${process.cwd()}/src/components/titlebar/TitleBar.tsx`,
    'utf8'
  )

  it('does not duplicate the full-screen connection indicator', () => {
    expect(source).not.toContain('useWsConnectionStatus')
    expect(source).not.toContain('Reconnecting…')
    expect(source).not.toContain('Loader2')
    expect(source).toContain(
      '<UnreadBell title={title} hideTitle={hideTitle} />'
    )
  })

  it('uses the client platform for native window chrome', () => {
    expect(source).toContain('isClientMacOS')
    expect(source).toContain('isClientLinux')
    expect(source).not.toContain('native && isMacOS')
    expect(source).not.toContain('native && isLinux')
  })

  it('shows a sticky jean-server update control in the title bar', () => {
    expect(source).toContain('ServerUpdateIndicator')
    expect(source).toContain('pendingServerUpdate')
    expect(source).toContain('Server update')
  })
})
