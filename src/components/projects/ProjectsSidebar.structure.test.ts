import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectsSidebar server filter', () => {
  it('shows Servers inside the Projects view, with a Projects/Recent toggle', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    const rail = readFileSync(
      'src/components/projects/SidebarTabRail.tsx',
      'utf8'
    )
    const mainWindow = readFileSync(
      'src/components/layout/MainWindow.tsx',
      'utf8'
    )

    expect(rail).toContain('role="tablist"')
    expect(rail).toContain('aria-orientation="vertical"')
    expect(rail).toContain('size-12')
    expect(source).toContain('<SidebarTabRail')
    expect(mainWindow).toContain('<SidebarTabRail')
    expect(source).toContain('<ServersList')
    expect(source).toContain('<RecentWorktreesList')
    expect(source).toContain('footerActionsContainer={footerActionsEl}')
    expect(source).toContain('ref={setFooterActionsEl}')
    expect(source).toContain('state => state.sidebarActiveTab')
    expect(source).toContain('aria-label="Workspace view"')
    expect(source).toContain('Add server')
    expect(source).not.toContain("activeTab === 'servers'")
    expect(rail).toContain("label: 'Workspace'")
  })

  it('uses a compact dropdown that blends into the sidebar', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('className="px-3 py-2"')
    expect(source).toContain('<DropdownMenuTrigger')
    expect(source).toContain('aria-label="Filter projects by server"')
    expect(source).toContain(
      'border-transparent bg-transparent pl-7 pr-2 text-xs shadow-none focus-visible:border-transparent dark:bg-transparent'
    )
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

  it('places quiet creation controls after search and before the project list', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    const serverSelector = source.indexOf(
      'aria-label="Filter projects by server"'
    )
    const search = source.indexOf(
      'aria-label="Search projects, worktrees and servers"'
    )
    const addProject = source.indexOf('aria-label="Add project"')
    const addWorktree = source.indexOf(
      'aria-label="Add worktree to selected project"'
    )
    const projectTree = source.indexOf('<ProjectTree')

    expect(serverSelector).toBeGreaterThan(search)
    expect(addProject).toBeGreaterThan(search)
    expect(addWorktree).toBeGreaterThan(addProject)
    expect(serverSelector).toBeGreaterThan(addWorktree)
    expect(projectTree).toBeGreaterThan(serverSelector)
    expect(source.indexOf('<ServersList')).toBeGreaterThan(serverSelector)
    expect(projectTree).toBeGreaterThan(source.indexOf('<ServersList'))
    expect(source).toContain('<Plus className="size-3.5" />')
    expect(source).toContain('<GitBranchPlus className="size-3.5" />')
    expect(source).toContain('disabled={!selectedProjectId}')
    expect(source).toContain('className="flex gap-1 px-3 pt-1"')
    expect(source).toContain('border-transparent bg-transparent')
    expect(source).toContain('searchQuery={searchQuery}')
    expect(source).not.toContain('aria-label="New"')
    expect(source).not.toContain('{/* Footer')
  })

  it('aligns its divider with the session header divider', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('className="border-b border-border/40 pb-2"')
  })

  it('does not draw dividers between local and remote server sections', () => {
    const source = readFileSync(
      'src/components/projects/ProjectTree.tsx',
      'utf8'
    )

    expect(source).not.toContain('sectionIndex > 0')
  })

  it('places Settings at the bottom of the tab rail', () => {
    const sidebar = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )
    const rail = readFileSync(
      'src/components/projects/SidebarTabRail.tsx',
      'utf8'
    )

    expect(sidebar).not.toContain('aria-label="Open Settings"')
    expect(rail.indexOf('aria-label="Open Settings"')).toBeGreaterThan(
      rail.indexOf('role="tablist"')
    )
    expect(rail).toContain('data-testid="sidebar-settings"')
    expect(rail).toContain('togglePreferences()')
  })

  it('adds bottom safe-area spacing to the footer in web access', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain(
      "showServerMenu ? 'px-2 pt-2 pb-4' : 'px-2 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]'"
    )
  })

  it('places the app version at the bottom-right of the sidebar footer', () => {
    const sidebar = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )
    const titleBar = readFileSync(
      'src/components/titlebar/TitleBar.tsx',
      'utf8'
    )

    expect(sidebar).toContain('data-testid="sidebar-app-version"')
    expect(sidebar).toContain('justify-between')
    expect(sidebar).toContain('v{appVersion}')
    expect(titleBar).not.toContain('v{appVersion}')
  })
})
