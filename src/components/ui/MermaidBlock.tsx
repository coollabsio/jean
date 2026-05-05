import { memo, useEffect, useId, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/hooks/use-theme'

function resolveTheme(theme: string): 'dark' | 'default' {
  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'default'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'default'
}

export const MermaidBlock = memo(function MermaidBlock({
  code,
}: {
  code: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const reactId = useId()
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9-]/g, '')}`
  const { theme } = useTheme()
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [rendered, setRendered] = useState(true)

  useEffect(() => {
    if (!rendered) return
    let cancelled = false
    ;(async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: resolveTheme(theme),
          securityLevel: 'loose',
          fontFamily: 'inherit',
        })
        const { svg, bindFunctions } = await mermaid.render(renderId, code)
        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = svg
        bindFunctions?.(containerRef.current)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, theme, renderId, rendered])

  const handleCopy = () => {
    copyToClipboard(code)
    toast.success('Copied diagram source')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative my-5 rounded-lg bg-muted p-4">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <span>Render</span>
              <Switch
                checked={rendered}
                onCheckedChange={setRendered}
                aria-label="Toggle mermaid rendering"
              />
            </label>
          </TooltipTrigger>
          <TooltipContent>
            {rendered ? 'Show source' : 'Render diagram'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              className="opacity-50 hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-background/80 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy diagram source</TooltipContent>
        </Tooltip>
      </div>
      {!rendered ? (
        <pre className="overflow-x-auto pr-32 text-sm">
          <code className="language-mermaid">{code}</code>
        </pre>
      ) : error ? (
        <div className="space-y-2 pr-32">
          <div className="text-xs text-destructive">
            Failed to render mermaid diagram: {error}
          </div>
          <pre className="overflow-x-auto text-xs text-muted-foreground">
            {code}
          </pre>
        </div>
      ) : (
        <div ref={containerRef} className="overflow-x-auto pr-32" />
      )}
    </div>
  )
})
