import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/projects'
import {
  canCreateNestedFolder,
  collectDescendantFolderIds,
  collectDescendantProjects,
  folderNestingLevel,
  isContextMenuNearElement,
  suppressSidebarChromeContextMenu,
  visibleWorktreeIds,
} from './sidebar-context-menu'

function project(partial: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    name: partial.id,
    path: '',
    default_branch: 'main',
    added_at: 0,
    order: 0,
    ...partial,
  }
}

describe('suppressSidebarChromeContextMenu', () => {
  it('prevents the webview menu on sidebar chrome', () => {
    const event = new MouseEvent('contextmenu', { cancelable: true })
    Object.defineProperty(event, 'target', { value: document.body })
    suppressSidebarChromeContextMenu(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves text fields to their own menu', () => {
    const input = document.createElement('input')
    const event = new MouseEvent('contextmenu', { cancelable: true })
    Object.defineProperty(event, 'target', { value: input })
    suppressSidebarChromeContextMenu(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('isContextMenuNearElement', () => {
  it('treats clicks inside and just below the element as near', () => {
    const element = document.createElement('div')
    element.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 180,
        left: 0,
        right: 0,
        width: 0,
        height: 80,
        x: 0,
        y: 100,
        toJSON() {
          return {}
        },
      }) as DOMRect

    expect(isContextMenuNearElement({ clientY: 140 }, element)).toBe(true)
    expect(isContextMenuNearElement({ clientY: 200 }, element)).toBe(true)
    expect(isContextMenuNearElement({ clientY: 400 }, element)).toBe(false)
    expect(isContextMenuNearElement({ clientY: 140 }, null)).toBe(false)
  })
})

describe('folder tree context helpers', () => {
  const projects = [
    project({ id: 'root-folder', is_folder: true }),
    project({ id: 'child-folder', is_folder: true, parent_id: 'root-folder' }),
    project({
      id: 'grand-folder',
      is_folder: true,
      parent_id: 'child-folder',
    }),
    project({ id: 'root-project', parent_id: 'root-folder' }),
    project({ id: 'nested-project', parent_id: 'child-folder' }),
  ]

  it('measures nesting the same way create_folder does', () => {
    expect(folderNestingLevel(projects, 'root-folder')).toBe(0)
    expect(folderNestingLevel(projects, 'child-folder')).toBe(1)
    expect(folderNestingLevel(projects, 'grand-folder')).toBe(2)
    expect(canCreateNestedFolder(projects, 'child-folder')).toBe(true)
    expect(canCreateNestedFolder(projects, 'grand-folder')).toBe(false)
  })

  it('collects nested projects and folders under a folder', () => {
    expect(
      collectDescendantProjects(projects, 'root-folder')
        .map(item => item.id)
        .sort()
    ).toEqual(['nested-project', 'root-project'])
    expect(collectDescendantFolderIds(projects, 'root-folder').sort()).toEqual([
      'child-folder',
      'grand-folder',
    ])
  })

  it('skips auto-fix worktrees when expanding sessions', () => {
    expect(
      visibleWorktreeIds([
        { id: 'wt-1', origin: 'manual' },
        { id: 'fix', origin: 'auto_fix' },
        { id: 'wt-2' },
      ] as never)
    ).toEqual(['wt-1', 'wt-2'])
  })
})
