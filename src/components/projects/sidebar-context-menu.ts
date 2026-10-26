import type { MouseEvent as ReactMouseEvent } from 'react'
import { isFolder, type Project, type Worktree } from '@/types/projects'

/**
 * Rust `create_folder` rejects a parent whose nesting level is already 2
 * (`Maximum folder nesting depth (3) exceeded`).
 */
export const MAX_NEW_FOLDER_PARENT_LEVEL = 2

/** Vertical slack for "near the Folders section" empty-space clicks. */
export const SIDEBAR_FOLDER_CONTEXT_NEAR_PX = 32

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"]'

/**
 * Hide the webview context menu on sidebar chrome that has no Jean menu.
 * Text fields keep their own menu: rename inputs use the native edit menu,
 * and the search field opens Cut/Copy/Paste (which prevents the default).
 */
export function suppressSidebarChromeContextMenu(
  event: ReactMouseEvent | MouseEvent
): void {
  const target = event.target
  if (target instanceof Element && target.closest(EDITABLE_SELECTOR)) return
  event.preventDefault()
}

export function isContextMenuNearElement(
  event: { clientY: number },
  element: HTMLElement | null,
  nearPx = SIDEBAR_FOLDER_CONTEXT_NEAR_PX
): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return (
    event.clientY >= rect.top - nearPx && event.clientY <= rect.bottom + nearPx
  )
}

export function folderNestingLevel(
  projects: readonly Project[],
  folderId: string
): number {
  const byId = new Map(projects.map(project => [project.id, project]))
  let depth = 0
  let current = byId.get(folderId)
  const seen = new Set<string>()
  while (current?.parent_id) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    depth += 1
    current = byId.get(current.parent_id)
  }
  return depth
}

export function canCreateNestedFolder(
  projects: readonly Project[],
  folderId: string
): boolean {
  return folderNestingLevel(projects, folderId) < MAX_NEW_FOLDER_PARENT_LEVEL
}

function childrenByParent(
  projects: readonly Project[]
): Map<string, Project[]> {
  const grouped = new Map<string, Project[]>()
  for (const project of projects) {
    if (!project.parent_id) continue
    const siblings = grouped.get(project.parent_id)
    if (siblings) siblings.push(project)
    else grouped.set(project.parent_id, [project])
  }
  return grouped
}

function walkDescendants(
  projects: readonly Project[],
  folderId: string,
  include: 'projects' | 'folders'
): Project[] {
  const grouped = childrenByParent(projects)
  const matches: Project[] = []
  const stack = [...(grouped.get(folderId) ?? [])]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const item = stack.pop()
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    if (isFolder(item)) {
      if (include === 'folders') matches.push(item)
      stack.push(...(grouped.get(item.id) ?? []))
    } else if (include === 'projects') {
      matches.push(item)
    }
  }
  return matches
}

/** Projects inside a folder, including projects nested in child folders. */
export function collectDescendantProjects(
  projects: readonly Project[],
  folderId: string
): Project[] {
  return walkDescendants(projects, folderId, 'projects')
}

/** Child folders of a folder, not including the folder itself. */
export function collectDescendantFolderIds(
  projects: readonly Project[],
  folderId: string
): string[] {
  return walkDescendants(projects, folderId, 'folders').map(folder => folder.id)
}

/** Sidebar session rows skip auto-fix worktrees, same as the project tree. */
export function visibleWorktreeIds(worktrees: readonly Worktree[]): string[] {
  return worktrees.flatMap(worktree =>
    worktree.origin === 'auto_fix' ? [] : [worktree.id]
  )
}
