import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('TitleBar file-browser placement', () => {
  it('uses a mirrored panel control in the right action group', () => {
    const source = readFileSync('src/components/titlebar/TitleBar.tsx', 'utf8')
    const rightGroup = source.indexOf(
      '{/* Right side - Actions + Windows/Linux window controls'
    )
    const fileBrowser = source.indexOf('data-testid="toggle-file-browser"')

    expect(fileBrowser).toBeGreaterThan(rightGroup)
    expect(source).toContain('<PanelRightClose className="size-3.5" />')
    expect(source).toContain('<PanelRight className="size-3.5" />')
    expect(source).not.toContain('<FolderTree')
  })

  it('puts GitHub before the far-right file browser control in web access', () => {
    const source = readFileSync('src/components/titlebar/TitleBar.tsx', 'utf8')
    const rightGroup = source.indexOf(
      '{/* Right side - Actions + Windows/Linux window controls'
    )
    const webGitHub = source.indexOf('data-testid="open-github-web"')
    const webFileBrowser = source.lastIndexOf(
      'data-testid="toggle-file-browser"'
    )

    expect(webGitHub).toBeGreaterThan(rightGroup)
    expect(webFileBrowser).toBeGreaterThan(webGitHub)
    expect(source).toContain('{native && !isMobile && (')
  })

  it('does not keep Settings in the title bar', () => {
    const source = readFileSync('src/components/titlebar/TitleBar.tsx', 'utf8')

    expect(source).not.toContain('commandContext.openPreferences')
    expect(source).not.toContain('<Settings className="size-3.5" />')
  })
})
