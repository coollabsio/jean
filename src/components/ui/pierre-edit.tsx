/**
 * Shared Pierre Diffs edit-mode helpers.
 * Edit mode lives in `@pierre/diffs/edit` and is wired through React via EditProvider.
 */
import { useCallback, type ReactNode } from 'react'
import { EditProvider } from '@pierre/diffs/react'
import { Editor } from '@pierre/diffs/edit'
import type { EditorOptions } from '@pierre/diffs/edit'
import type { DiffsThemeNames } from '@pierre/diffs'
import type { SyntaxTheme } from '@/types/preferences'

/** Stable factory for Pierre Editor instances (one per editable surface). */
export function createPierreEditor<LAnnotation = undefined>(
  options: EditorOptions<LAnnotation>
) {
  return new Editor(options)
}

/** App-level monospace + selectable text for Pierre surfaces. */
export const PIERRE_UNSAFE_CSS = `
  pre { font-family: var(--font-family-mono) !important; font-size: calc(var(--ui-font-size) * 0.85) !important; line-height: var(--ui-line-height) !important; }
  * { user-select: text !important; -webkit-user-select: text !important; cursor: text !important; }
`

export function pierreThemePair(
  dark: SyntaxTheme | undefined,
  light: SyntaxTheme | undefined
): { dark: DiffsThemeNames; light: DiffsThemeNames } {
  return {
    dark: (dark ?? 'vitesse-black') as DiffsThemeNames,
    light: (light ?? 'github-light') as DiffsThemeNames,
  }
}

/**
 * Wraps children with Pierre's EditProvider so File / FileDiff can enable edit mode.
 */
export function PierreEditProvider({ children }: { children: ReactNode }) {
  const createEditor = useCallback(
    <LAnnotation,>(options: EditorOptions<LAnnotation>) =>
      createPierreEditor(options),
    []
  )

  return <EditProvider createEditor={createEditor}>{children}</EditProvider>
}
