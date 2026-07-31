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
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  syntaxHighlighting,
  HighlightStyle,
  type LanguageSupport,
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
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

/**
 * Jean light chrome — uses app CSS tokens (oklch/hex), not hsl() wrappers.
 * Matches :root tokens: white surface, dark text, soft muted panels.
 */
const jeanLightChrome = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--card)',
      color: 'var(--foreground)',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-family-mono, ui-monospace, monospace)',
      lineHeight: '1.55',
    },
    '.cm-content': {
      caretColor: 'var(--foreground)',
      fontSize: '12px',
      padding: '8px 0',
    },
    '.cm-line': {
      wordBreak: 'break-word',
      padding: '0 8px',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--foreground)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
      {
        backgroundColor: 'color-mix(in srgb, var(--primary) 18%, transparent)',
      },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 80%, transparent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--muted)',
      color: 'var(--muted-foreground)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--accent)',
      color: 'var(--accent-foreground)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 10px',
      minWidth: '2.5rem',
    },
    '.cm-foldGutter': {
      width: '0',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--primary) 14%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--primary) 35%, transparent)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--warning) 35%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--warning) 55%, transparent)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md, 0.5rem)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--muted)',
      color: 'var(--foreground)',
    },
  },
  { dark: false }
)

/**
 * Jean dark chrome — Coolify coolgray + yellow primary.
 * Matches .dark tokens: #101010 base, #181818 card, #fcd452 accent.
 */
const jeanDarkChrome = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--card)',
      color: 'var(--foreground)',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-family-mono, ui-monospace, monospace)',
      lineHeight: '1.55',
    },
    '.cm-content': {
      caretColor: 'var(--primary)',
      fontSize: '12px',
      padding: '8px 0',
    },
    '.cm-line': {
      wordBreak: 'break-word',
      padding: '0 8px',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--primary)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
      {
        backgroundColor: 'color-mix(in srgb, var(--primary) 22%, transparent)',
      },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 70%, transparent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--background)',
      color: 'var(--muted-foreground)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--accent)',
      color: 'var(--primary)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 10px',
      minWidth: '2.5rem',
    },
    '.cm-foldGutter': {
      width: '0',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--primary) 16%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--primary) 40%, transparent)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--primary) 28%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--primary) 45%, transparent)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md, 0.5rem)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--muted)',
      color: 'var(--foreground)',
    },
  },
  { dark: true }
)

/**
 * Syntax colors tuned for Jean light (readable on white / soft muted).
 */
const jeanLightHighlight = HighlightStyle.define([
  { tag: t.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.lineComment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.blockComment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.docComment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.keyword, color: '#7c3aed' },
  { tag: t.controlKeyword, color: '#7c3aed' },
  { tag: t.moduleKeyword, color: '#7c3aed' },
  { tag: t.operatorKeyword, color: '#7c3aed' },
  { tag: t.definitionKeyword, color: '#7c3aed' },
  { tag: t.self, color: '#c2410c' },
  { tag: t.bool, color: '#b45309' },
  { tag: t.null, color: '#b45309' },
  { tag: t.atom, color: '#b45309' },
  { tag: t.number, color: '#b45309' },
  { tag: t.integer, color: '#b45309' },
  { tag: t.float, color: '#b45309' },
  { tag: t.string, color: '#15803d' },
  { tag: t.special(t.string), color: '#15803d' },
  { tag: t.regexp, color: '#0f766e' },
  { tag: t.escape, color: '#0f766e' },
  { tag: t.variableName, color: '#1f2937' },
  { tag: t.definition(t.variableName), color: '#1d4ed8' },
  { tag: t.function(t.variableName), color: '#1d4ed8' },
  { tag: t.propertyName, color: '#0369a1' },
  { tag: t.definition(t.propertyName), color: '#0369a1' },
  { tag: t.typeName, color: '#a16207' },
  { tag: t.className, color: '#a16207' },
  { tag: t.namespace, color: '#a16207' },
  { tag: t.macroName, color: '#c026d3' },
  { tag: t.labelName, color: '#c026d3' },
  { tag: t.attributeName, color: '#0369a1' },
  { tag: t.attributeValue, color: '#15803d' },
  { tag: t.tagName, color: '#b91c1c' },
  { tag: t.angleBracket, color: '#6b7280' },
  { tag: t.operator, color: '#4b5563' },
  { tag: t.punctuation, color: '#4b5563' },
  { tag: t.bracket, color: '#4b5563' },
  { tag: t.paren, color: '#4b5563' },
  { tag: t.squareBracket, color: '#4b5563' },
  { tag: t.brace, color: '#4b5563' },
  { tag: t.meta, color: '#6b7280' },
  { tag: t.invalid, color: '#dc2626' },
  { tag: t.heading, color: '#1d4ed8', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: '#1d4ed8', textDecoration: 'underline' },
  { tag: t.url, color: '#0f766e' },
  { tag: t.monospace, color: '#1f2937' },
])

/**
 * Syntax colors for Jean dark coolgray + yellow accent.
 * Keywords lean amber/yellow; strings green (success); types soft gold.
 */
const jeanDarkHighlight = HighlightStyle.define([
  { tag: t.comment, color: '#7a7a7a', fontStyle: 'italic' },
  { tag: t.lineComment, color: '#7a7a7a', fontStyle: 'italic' },
  { tag: t.blockComment, color: '#7a7a7a', fontStyle: 'italic' },
  { tag: t.docComment, color: '#7a7a7a', fontStyle: 'italic' },
  { tag: t.keyword, color: '#fcd452' },
  { tag: t.controlKeyword, color: '#fcd452' },
  { tag: t.moduleKeyword, color: '#f0c14b' },
  { tag: t.operatorKeyword, color: '#fcd452' },
  { tag: t.definitionKeyword, color: '#fcd452' },
  { tag: t.self, color: '#f5a97f' },
  { tag: t.bool, color: '#f0a868' },
  { tag: t.null, color: '#f0a868' },
  { tag: t.atom, color: '#f0a868' },
  { tag: t.number, color: '#f0a868' },
  { tag: t.integer, color: '#f0a868' },
  { tag: t.float, color: '#f0a868' },
  { tag: t.string, color: '#4ade80' },
  { tag: t.special(t.string), color: '#4ade80' },
  { tag: t.regexp, color: '#2dd4bf' },
  { tag: t.escape, color: '#2dd4bf' },
  { tag: t.variableName, color: '#e8e8e8' },
  { tag: t.definition(t.variableName), color: '#7dd3fc' },
  { tag: t.function(t.variableName), color: '#7dd3fc' },
  { tag: t.propertyName, color: '#93c5fd' },
  { tag: t.definition(t.propertyName), color: '#93c5fd' },
  { tag: t.typeName, color: '#f0d78c' },
  { tag: t.className, color: '#f0d78c' },
  { tag: t.namespace, color: '#f0d78c' },
  { tag: t.macroName, color: '#e879f9' },
  { tag: t.labelName, color: '#e879f9' },
  { tag: t.attributeName, color: '#93c5fd' },
  { tag: t.attributeValue, color: '#4ade80' },
  { tag: t.tagName, color: '#f87171' },
  { tag: t.angleBracket, color: '#a1a1a1' },
  { tag: t.operator, color: '#c4c4c4' },
  { tag: t.punctuation, color: '#a1a1a1' },
  { tag: t.bracket, color: '#a1a1a1' },
  { tag: t.paren, color: '#a1a1a1' },
  { tag: t.squareBracket, color: '#a1a1a1' },
  { tag: t.brace, color: '#a1a1a1' },
  { tag: t.meta, color: '#7a7a7a' },
  { tag: t.invalid, color: '#f87171' },
  { tag: t.heading, color: '#fcd452', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: '#7dd3fc', textDecoration: 'underline' },
  { tag: t.url, color: '#2dd4bf' },
  { tag: t.monospace, color: '#e8e8e8' },
])

function jeanThemeExtensions(mode: 'dark' | 'light'): Extension[] {
  if (mode === 'dark') {
    return [jeanDarkChrome, syntaxHighlighting(jeanDarkHighlight)]
  }
  return [jeanLightChrome, syntaxHighlighting(jeanLightHighlight)]
}

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
 * Jean light/dark themes aligned with app CSS tokens.
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

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      // Soft-wrap long lines so mobile / narrow panels stay readable
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      themeCompartment.current.of(jeanThemeExtensions(resolvedTheme)),
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
    editorRef.current.dispatch({
      effects: themeCompartment.current.reconfigure(
        jeanThemeExtensions(resolvedTheme)
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
      className={`overflow-hidden rounded-md border border-border bg-card [&_.cm-editor]:h-full [&_.cm-editor]:outline-none [&_.cm-scroller]:overflow-auto ${className ?? ''}`}
    />
  )
})
