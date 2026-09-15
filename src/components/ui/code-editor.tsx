import { useMemo, memo, useRef } from 'react'
import { File } from '@pierre/diffs/react'
import type { FileContents } from '@pierre/diffs'
import type { EditorOptions } from '@pierre/diffs/edit'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences } from '@/services/preferences'
import { cn } from '@/lib/utils'
import {
  PierreEditProvider,
  PIERRE_UNSAFE_CSS,
  pierreThemePair,
} from '@/components/ui/pierre-edit'

export interface CodeEditorProps {
  /** Initial content of the editor (parent remounts via key when content must reset) */
  value: string
  /** Filename used for language detection and editor cache key */
  fileName?: string
  /** Language hint when filename is missing */
  language?: string
  /** Callback when content changes */
  onChange?: (value: string) => void
  /** Whether the editor is read-only (renders Pierre File without edit mode) */
  readOnly?: boolean
  /** Additional CSS class */
  className?: string
}

function guessFileName(language?: string): string {
  if (!language || language === 'text' || language === 'plaintext') {
    return 'file.txt'
  }
  return `file.${language}`
}

/**
 * Pierre Diffs File + edit-mode code editor.
 * Lazy-load this component (and `@pierre/diffs/edit`) so the main bundle stays lean.
 * Remount with a React `key` when external content should replace the document.
 */
export const CodeEditor = memo(function CodeEditor({
  value,
  fileName,
  language,
  onChange,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const { theme } = useTheme()
  const { data: preferences } = usePreferences()
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const resolvedTheme = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  const name = fileName || guessFileName(language)

  // Capture initial contents only — Pierre edit mode owns the document after attach.
  // Parent must remount (key change) when `value` should replace the session.
  const file: FileContents = useMemo(
    () => ({
      name,
      contents: value,
      cacheKey: name,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial session only
    [name]
  )

  const options = useMemo(
    () => ({
      theme: pierreThemePair(
        preferences?.syntax_theme_dark,
        preferences?.syntax_theme_light
      ),
      themeType: resolvedTheme,
      overflow: 'wrap' as const,
      disableFileHeader: true,
      unsafeCSS: PIERRE_UNSAFE_CSS,
    }),
    [
      resolvedTheme,
      preferences?.syntax_theme_dark,
      preferences?.syntax_theme_light,
    ]
  )

  const editorOptions = useMemo((): EditorOptions<undefined> => {
    return {
      persistState: true,
      onChange: nextFile => {
        onChangeRef.current?.(nextFile.contents)
      },
    }
  }, [])

  const fileSurface = (
    <File
      file={file}
      edit={!readOnly}
      editorOptions={readOnly ? undefined : editorOptions}
      options={options}
      className="h-full min-h-0"
    />
  )

  return (
    <div
      className={cn(
        'h-full min-h-0 min-w-0 overflow-auto rounded-md border border-border bg-card',
        className
      )}
    >
      {readOnly ? (
        fileSurface
      ) : (
        <PierreEditProvider>{fileSurface}</PierreEditProvider>
      )}
    </div>
  )
})

export default CodeEditor
