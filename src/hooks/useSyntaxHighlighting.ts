import { useState, useEffect } from 'react'
import { createHighlighter, type Highlighter, type BundledTheme } from 'shiki'
import type { SyntaxTheme } from '@/types/preferences'

// Singleton highlighter promise
let highlighterPromise: Promise<Highlighter> | null = null

// All themes we support
const THEMES: BundledTheme[] = [
  'vitesse-black',
  'vitesse-dark',
  'vitesse-light',
  'github-dark',
  'github-light',
  'github-dark-dimmed',
  'dracula',
  'dracula-soft',
  'nord',
  'catppuccin-mocha',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'catppuccin-latte',
  'one-dark-pro',
  'one-light',
  'tokyo-night',
  'rose-pine',
  'rose-pine-moon',
  'rose-pine-dawn',
]

/**
 * Get or create the singleton highlighter instance
 * Lazy-loads themes and common languages
 */
async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: THEMES,
      langs: [
        'typescript',
        'tsx',
        'javascript',
        'jsx',
        'json',
        'jsonc',
        'yaml',
        'toml',
        'markdown',
        'html',
        'css',
        'rust',
        'python',
        'go',
        'bash',
        'sql',
        'graphql',
        'diff',
        'text',
      ],
    })
  }
  return highlighterPromise
}

interface SyntaxHighlightingResult {
  /** Highlighted HTML string, or null while loading */
  html: string | null
  /** Whether highlighting is in progress */
  isLoading: boolean
  /** Error message if highlighting failed */
  error: string | null
}

/**
 * Hook for syntax highlighting code using shiki
 *
 * @param code - The code to highlight
 * @param language - The shiki language ID
 * @param theme - The shiki theme name
 * @returns Object with highlighted HTML, loading state, and error
 */
export function useSyntaxHighlighting(
  code: string | null,
  language: string,
  theme: SyntaxTheme
): SyntaxHighlightingResult {
  const [html, setHtml] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!code) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(null)
      setIsLoading(false)
      setError(null)
      return
    }

    // Capture code in a const so TypeScript knows it's non-null in the async closure
    const codeToHighlight = code

    let cancelled = false
    setIsLoading(true)
    setError(null)

    async function highlight() {
      try {
        const highlighter = await getHighlighter()

        // Load language if not already loaded
        const loadedLangs = highlighter.getLoadedLanguages()
        if (!loadedLangs.includes(language as never)) {
          try {
            await highlighter.loadLanguage(language as never)
          } catch {
            // Language not available, fall back to text
            if (!loadedLangs.includes('text')) {
              await highlighter.loadLanguage('text')
            }
          }
        }

        if (cancelled) return

        // Get loaded languages again after potential load
        const availableLangs = highlighter.getLoadedLanguages()
        const langToUse = availableLangs.includes(language as never)
          ? language
          : 'text'

        const result = highlighter.codeToHtml(codeToHighlight, {
          lang: langToUse,
          theme: theme as BundledTheme,
        })

        if (!cancelled) {
          setHtml(result)
          setIsLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setIsLoading(false)
        }
      }
    }

    highlight()

    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  return { html, isLoading, error }
}

/**
 * Synchronous highlighting for small code snippets
 * Falls back to plain text if highlighter isn't ready
 */
export async function highlightCode(
  code: string,
  language: string,
  theme: SyntaxTheme
): Promise<string> {
  const highlighter = await getHighlighter()

  // Try to load language
  const loadedLangs = highlighter.getLoadedLanguages()
  if (!loadedLangs.includes(language as never)) {
    try {
      await highlighter.loadLanguage(language as never)
    } catch {
      // Fall back to text
    }
  }

  const availableLangs = highlighter.getLoadedLanguages()
  const langToUse = availableLangs.includes(language as never)
    ? language
    : 'text'

  return highlighter.codeToHtml(code, {
    lang: langToUse,
    theme: theme as BundledTheme,
  })
}
