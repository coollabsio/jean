import { useEffect, useState } from 'react'
import { useTheme } from '@/hooks/use-theme'

interface Token {
  content: string
  color?: string
}

type TokenLines = Token[][]

/**
 * Small, on-demand syntax-highlighted shell command. The Shiki bundle is only
 * requested after a tool call is expanded.
 */
export function ShellCommand({ command }: { command: string }) {
  const [lines, setLines] = useState<TokenLines | null>(null)
  const { theme } = useTheme()

  useEffect(() => {
    let cancelled = false
    const isDark =
      theme === 'dark' ||
      (theme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)

    import('@/lib/bash-highlighting')
      .then(({ highlightBash }) => highlightBash(command, isDark))
      .then(result => {
        if (!cancelled) setLines(result.tokens)
      })
      .catch(() => {
        if (!cancelled) setLines([])
      })

    return () => {
      cancelled = true
    }
  }, [command, theme])

  if (!lines || lines.length === 0) {
    return <code className="font-mono text-foreground/80">$ {command}</code>
  }

  return (
    <code className="font-mono text-foreground/80">
      {lines.map((line, lineIndex) => (
        <span key={lineIndex}>
          {lineIndex === 0 && <span className="text-muted-foreground/60">$ </span>}
          {line.map((token, tokenIndex) => (
            <span key={tokenIndex} style={{ color: token.color }}>
              {token.content}
            </span>
          ))}
          {lineIndex < lines.length - 1 && '\n'}
        </span>
      ))}
    </code>
  )
}
