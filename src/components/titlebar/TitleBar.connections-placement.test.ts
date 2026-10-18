import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('TitleBar connection placement', () => {
  it('does not show the Connections button', () => {
    const source = readFileSync('src/components/titlebar/TitleBar.tsx', 'utf8')

    expect(source).not.toContain('RemoteConnectionsDialog')
  })

  it('shows the server label without a server icon', () => {
    const source = readFileSync('src/components/titlebar/TitleBar.tsx', 'utf8')

    expect(source).not.toContain('<Server className="size-3" />')
  })

  it('keeps remote server refresh out of the header', () => {
    const source = readFileSync('src/components/titlebar/TitleBar.tsx', 'utf8')

    expect(source).not.toContain('RemoteServerRefreshButton')
    expect(source).not.toContain('resolveHeaderRemoteServer')
  })
})
