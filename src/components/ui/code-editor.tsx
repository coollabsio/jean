import { useEffect, useRef, useMemo, useCallback, memo } from 'react'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  drawSelection,
  highlightActiveLine,
  rectangularSelection,
  crosshairCursor,
  dropCursor,
} from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  type LanguageSupport,
} from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { useTheme } from '@/hooks/use-theme'

// Map language IDs to CodeMirror language support
function getLanguageSupport(language: string): LanguageSupport | null {
  switch (language) {
    case 'typescript':
    case 'tsx':
      return javascript({ typescript: true, jsx: language === 'tsx' })
    case 'javascript':
    case 'jsx':
      return javascript({ jsx: language === 'jsx' })
    case 'json':
    case 'jsonc':
      return json()
    case 'html':
      return html()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'markdown':
    case 'mdx':
      return markdown()
    case 'python':
      return python()
    case 'rust':
      return rust()
    case 'sql':
      return sql()
    case 'yaml':
      return yaml()
    default:
      return null
  }
}

// Light theme (simple, matches app background)
const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--foreground))',
  },
  '.cm-content': {
    caretColor: 'hsl(var(--foreground))',
    fontFamily: 'var(--font-family-mono, ui-monospace, monospace)',
    fontSize: '12px',
  },
  '.cm-cursor': {
    borderLeftColor: 'hsl(var(--foreground))',
  },
  '.cm-activeLine': {
    backgroundColor: 'hsl(var(--accent) / 0.5)',
  },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'hsl(var(--accent) / 0.5)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'hsl(var(--accent))',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'hsl(var(--accent))',
  },
})

// Dark theme based on oneDark but customized
const darkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--foreground))',
  },
  '.cm-content': {
    caretColor: 'hsl(var(--foreground))',
    fontFamily: 'var(--font-family-mono, ui-monospace, monospace)',
    fontSize: '12px',
  },
  '.cm-cursor': {
    borderLeftColor: 'hsl(var(--foreground))',
  },
  '.cm-activeLine': {
    backgroundColor: 'hsl(var(--accent) / 0.3)',
  },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'hsl(var(--accent) / 0.3)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'hsl(var(--accent))',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'hsl(var(--accent))',
  },
})

interface CodeEditorProps {
  /** Initial content of the editor */
  value: string
  /** Language for syntax highlighting */
  language: string
  /** Callback when content changes */
  onChange?: (value: string) => void
  /** Whether the editor is read-only */
  readOnly?: boolean
  /** Additional CSS class */
  className?: string
}

/**
 * CodeMirror 6 based code editor component
 * Supports syntax highlighting for common languages
 */
export const CodeEditor = memo(function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const { theme } = useTheme()

  // Resolve 'system' theme to actual dark/light
  const resolvedTheme = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  // Create or update editor
  useEffect(() => {
    if (!containerRef.current) return

    // If editor exists, destroy it first
    if (editorRef.current) {
      editorRef.current.destroy()
    }

    const langSupport = getLanguageSupport(language)
    const isDark = resolvedTheme === 'dark'

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      themeCompartment.current.of(isDark ? [oneDark, darkTheme] : lightTheme),
      languageCompartment.current.of(langSupport ? [langSupport] : []),
      readOnlyCompartment.current.of(
        readOnly ? EditorState.readOnly.of(true) : []
      ),
      EditorView.updateListener.of(update => {
        if (update.docChanged && onChange) {
          onChange(update.state.doc.toString())
        }
      }),
      // Enable native clipboard handling
      EditorView.domEventHandlers({
        copy: () => false, // Let browser handle copy
        cut: () => false, // Let browser handle cut
        paste: () => false, // Let browser handle paste
      }),
    ]

    const state = EditorState.create({
      doc: value,
      extensions,
    })

    editorRef.current = new EditorView({
      state,
      parent: containerRef.current,
    })

    return () => {
      editorRef.current?.destroy()
      editorRef.current = null
    }
    // We only want to recreate the editor when key props change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update theme when it changes
  useEffect(() => {
    if (!editorRef.current) return
    const isDark = resolvedTheme === 'dark'
    editorRef.current.dispatch({
      effects: themeCompartment.current.reconfigure(
        isDark ? [oneDark, darkTheme] : lightTheme
      ),
    })
  }, [resolvedTheme])

  // Update language when it changes
  useEffect(() => {
    if (!editorRef.current) return
    const langSupport = getLanguageSupport(language)
    editorRef.current.dispatch({
      effects: languageCompartment.current.reconfigure(
        langSupport ? [langSupport] : []
      ),
    })
  }, [language])

  // Update read-only state when it changes
  useEffect(() => {
    if (!editorRef.current) return
    editorRef.current.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? EditorState.readOnly.of(true) : []
      ),
    })
  }, [readOnly])

  // Update content when value changes externally (e.g., file reload)
  const updateContent = useCallback((newValue: string) => {
    if (!editorRef.current) return
    const currentValue = editorRef.current.state.doc.toString()
    if (currentValue !== newValue) {
      editorRef.current.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: newValue,
        },
      })
    }
  }, [])

  // Expose updateContent for external use
  useEffect(() => {
    updateContent(value)
  }, [value, updateContent])

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden rounded-md [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto ${className ?? ''}`}
    />
  )
})
