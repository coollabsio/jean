import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectsSidebar server filter', () => {
  it('uses a compact dropdown that blends into the sidebar', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('className="px-3 pb-1 pt-2"')
    expect(source).toContain('<DropdownMenuTrigger')
    expect(source).toContain('aria-label="Filter projects by server"')
    expect(source).toContain('border-transparent bg-transparent')
    expect(source).not.toContain('<SelectTrigger')
  })

  it('opens Connections from the server dropdown', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('Connections')
    expect(source).not.toContain('Jean connections')
    expect(source).toContain('setConnectionsOpen(true)')
    expect(source).toContain('<RemoteConnectionsDialog')
  })

  it('does not expose server feature surfaces in the footer', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).not.toContain('ServerFeatureSurfaces')
    expect(source).not.toContain('>Features<')
  })

  it('shows a labeled add-project action below the server selector', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    const serverSelector = source.indexOf(
      'aria-label="Filter projects by server"'
    )
    const addProject = source.indexOf('>Add project<')
    const projectTree = source.indexOf('<ProjectTree')

    expect(serverSelector).toBeGreaterThan(-1)
    expect(addProject).toBeGreaterThan(serverSelector)
    expect(projectTree).toBeGreaterThan(addProject)
    expect(source).toContain('<Plus className="size-3.5" />')
    expect(source).not.toContain('aria-label="New"')
    expect(source).not.toContain('{/* Footer')
  })

  it('does not draw dividers between local and remote server sections', () => {
    const source = readFileSync(
      'src/components/projects/ProjectTree.tsx',
      'utf8'
    )

    expect(source).not.toContain('sectionIndex > 0')
  })
})
