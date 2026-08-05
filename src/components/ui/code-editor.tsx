import {
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  memo,
} from 'react'
import type * as CmView from '@codemirror/view'
import type * as CmState from '@codemirror/state'
import type * as CmCommands from '@codemirror/commands'
import type * as CmLanguage from '@codemirror/language'
import type * as LezerHighlight from '@lezer/highlight'
import { useTheme } from '@/hooks/use-theme'

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

interface CodeMirrorModules {
  EditorView: typeof CmView.EditorView
  keymap: typeof CmView.keymap
  lineNumbers: typeof CmView.lineNumbers
  highlightActiveLineGutter: typeof CmView.highlightActiveLineGutter
  drawSelection: typeof CmView.drawSelection
  highlightActiveLine: typeof CmView.highlightActiveLine
  rectangularSelection: typeof CmView.rectangularSelection
  crosshairCursor: typeof CmView.crosshairCursor
  dropCursor: typeof CmView.dropCursor
  EditorState: typeof CmState.EditorState
  Compartment: typeof CmState.Compartment
  defaultKeymap: typeof CmCommands.defaultKeymap
  history: typeof CmCommands.history
  historyKeymap: typeof CmCommands.historyKeymap
  syntaxHighlighting: typeof CmLanguage.syntaxHighlighting
  HighlightStyle: typeof CmLanguage.HighlightStyle
  tags: typeof LezerHighlight.tags
  getLanguageSupport: (
    language: string
  ) => CmLanguage.LanguageSupport | null
}

let modulesPromise: Promise<CodeMirrorModules> | null = null

function loadCodeMirrorModules(): Promise<CodeMirrorModules> {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('@codemirror/view'),
      import('@codemirror/state'),
      import('@codemirror/commands'),
      import('@codemirror/language'),
      import('@lezer/highlight'),
      import('@codemirror/lang-javascript'),
      import('@codemirror/lang-json'),
      import('@codemirror/lang-html'),
      import('@codemirror/lang-css'),
      import('@codemirror/lang-markdown'),
      import('@codemirror/lang-python'),
      import('@codemirror/lang-rust'),
      import('@codemirror/lang-sql'),
      import('@codemirror/lang-yaml'),
    ]).then(
      ([
        view,
        state,
        commands,
        language,
        highlight,
        langJs,
        langJson,
        langHtml,
        langCss,
        langMd,
        langPy,
        langRust,
        langSql,
        langYaml,
      ]) => {
        const getLanguageSupport = (
          lang: string
        ): CmLanguage.LanguageSupport | null => {
          switch (lang) {
            case 'typescript':
            case 'tsx':
              return langJs.javascript({
                typescript: true,
                jsx: lang === 'tsx',
              })
            case 'javascript':
            case 'jsx':
              return langJs.javascript({ jsx: lang === 'jsx' })
            case 'json':
            case 'jsonc':
              return langJson.json()
            case 'html':
              return langHtml.html()
            case 'css':
            case 'scss':
            case 'less':
              return langCss.css()
            case 'markdown':
            case 'mdx':
              return langMd.markdown()
            case 'python':
              return langPy.python()
            case 'rust':
              return langRust.rust()
            case 'sql':
              return langSql.sql()
            case 'yaml':
              return langYaml.yaml()
            default:
              return null
          }
        }

        return {
          EditorView: view.EditorView,
          keymap: view.keymap,
          lineNumbers: view.lineNumbers,
          highlightActiveLineGutter: view.highlightActiveLineGutter,
          drawSelection: view.drawSelection,
          highlightActiveLine: view.highlightActiveLine,
          rectangularSelection: view.rectangularSelection,
          crosshairCursor: view.crosshairCursor,
          dropCursor: view.dropCursor,
          EditorState: state.EditorState,
          Compartment: state.Compartment,
          defaultKeymap: commands.defaultKeymap,
          history: commands.history,
          historyKeymap: commands.historyKeymap,
          syntaxHighlighting: language.syntaxHighlighting,
          HighlightStyle: language.HighlightStyle,
          tags: highlight.tags,
          getLanguageSupport,
        }
      }
    )
  }
  return modulesPromise
}

function jeanThemeExtensions(
  cm: CodeMirrorModules,
  mode: 'dark' | 'light'
): CmState.Extension[] {
  const { EditorView, syntaxHighlighting, HighlightStyle, tags: t } = cm

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
          backgroundColor:
            'color-mix(in srgb, var(--primary) 18%, transparent)',
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
        outline:
          '1px solid color-mix(in srgb, var(--primary) 35%, transparent)',
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
          backgroundColor:
            'color-mix(in srgb, var(--primary) 22%, transparent)',
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
        outline:
          '1px solid color-mix(in srgb, var(--primary) 40%, transparent)',
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

  /** Syntax colors tuned for Jean light (readable on white / soft muted). */
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

  if (mode === 'dark') {
    return [jeanDarkChrome, syntaxHighlighting(jeanDarkHighlight)]
  }
  return [jeanLightChrome, syntaxHighlighting(jeanLightHighlight)]
}

/**
 * CodeMirror 6 based code editor component
 * Jean light/dark themes aligned with app CSS tokens.
 * CodeMirror is loaded on demand so the main bundle stays lean.
 */
export const CodeEditor = memo(function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const themeCompartment = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const languageCompartment = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readOnlyCompartment = useRef<any>(null)
  const modulesRef = useRef<CodeMirrorModules | null>(null)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  const languageRef = useRef(language)
  const readOnlyRef = useRef(readOnly)
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
  const resolvedThemeRef = useRef(resolvedTheme)

  useLayoutEffect(() => {
    onChangeRef.current = onChange
    valueRef.current = value
    languageRef.current = language
    readOnlyRef.current = readOnly
    resolvedThemeRef.current = resolvedTheme
  })

  // Create editor once CodeMirror modules are loaded
  useEffect(() => {
    let cancelled = false

    loadCodeMirrorModules().then(cm => {
      if (cancelled || !containerRef.current) return
      modulesRef.current = cm

      if (editorRef.current) {
        editorRef.current.destroy()
      }

      if (!themeCompartment.current) {
        themeCompartment.current = new cm.Compartment()
      }
      if (!languageCompartment.current) {
        languageCompartment.current = new cm.Compartment()
      }
      if (!readOnlyCompartment.current) {
        readOnlyCompartment.current = new cm.Compartment()
      }

      const langSupport = cm.getLanguageSupport(languageRef.current)

      const extensions = [
        cm.lineNumbers(),
        cm.highlightActiveLineGutter(),
        cm.highlightActiveLine(),
        cm.drawSelection(),
        cm.dropCursor(),
        cm.rectangularSelection(),
        cm.crosshairCursor(),
        cm.history(),
        // Soft-wrap long lines so mobile / narrow panels stay readable
        cm.EditorView.lineWrapping,
        cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]),
        themeCompartment.current.of(
          jeanThemeExtensions(cm, resolvedThemeRef.current)
        ),
        languageCompartment.current.of(langSupport ? [langSupport] : []),
        readOnlyCompartment.current.of(
          readOnlyRef.current ? cm.EditorState.readOnly.of(true) : []
        ),
        cm.EditorView.updateListener.of(
          (update: { docChanged: boolean; state: { doc: { toString(): string } } }) => {
            if (update.docChanged && onChangeRef.current) {
              onChangeRef.current(update.state.doc.toString())
            }
          }
        ),
        // Enable native clipboard handling
        cm.EditorView.domEventHandlers({
          copy: () => false, // Let browser handle copy
          cut: () => false, // Let browser handle cut
          paste: () => false, // Let browser handle paste
        }),
      ]

      const state = cm.EditorState.create({
        doc: valueRef.current,
        extensions,
      })

      editorRef.current = new cm.EditorView({
        state,
        parent: containerRef.current,
      })
    })

    return () => {
      cancelled = true
      editorRef.current?.destroy()
      editorRef.current = null
    }
  }, [])

  // Update theme when it changes
  useEffect(() => {
    const cm = modulesRef.current
    if (!editorRef.current || !cm) return
    editorRef.current.dispatch({
      effects: themeCompartment.current.reconfigure(
        jeanThemeExtensions(cm, resolvedTheme)
      ),
    })
  }, [resolvedTheme])

  // Update language when it changes
  useEffect(() => {
    const cm = modulesRef.current
    if (!editorRef.current || !cm) return
    const langSupport = cm.getLanguageSupport(language)
    editorRef.current.dispatch({
      effects: languageCompartment.current.reconfigure(
        langSupport ? [langSupport] : []
      ),
    })
  }, [language])

  // Update read-only state when it changes
  useEffect(() => {
    const cm = modulesRef.current
    if (!editorRef.current || !cm) return
    editorRef.current.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? cm.EditorState.readOnly.of(true) : []
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

export default CodeEditor
