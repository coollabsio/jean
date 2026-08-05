import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { FileBrowserSidebar } from './FileBrowserSidebar'
import type * as FilesService from '@/services/files'
import type * as ProjectsService from '@/services/projects'

/**
 * Regression for #628: when useWorktreeFiles returns undefined data
 * (query disabled / loading), defaulting with inline `= []` produced a new
 * array identity every render. Combined with the search auto-expand effect
 * that always called setExpanded(new Set(...)), that caused React error #185
 * (maximum update depth exceeded).
 */
vi.mock('@/services/files', async () => {
  const actual = await vi.importActual<typeof FilesService>('@/services/files')
  return {
    ...actual,
    // Keep data undefined forever — the crash path when rootPath is null
    // (query enabled: false) or cache is cold while switching projects.
    useWorktreeFiles: () => ({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
    }),
  }
})

vi.mock('@/services/projects', async () => {
  const actual = await vi.importActual<typeof ProjectsService>(
    '@/services/projects'
  )
  return {
    ...actual,
    useWorktree: () => ({ data: undefined }),
    useProjects: () => ({ data: [] }),
  }
})

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

describe('FileBrowserSidebar', () => {
  it('does not infinite-loop when worktree files data is undefined', () => {
    // If the #185 loop regressed, React would throw during render/effect.
    render(<FileBrowserSidebar />)

    expect(screen.getByTestId('file-browser-sidebar')).toBeTruthy()
    expect(
      screen.getByText('Select a project or worktree to browse files.')
    ).toBeTruthy()
  })
})
