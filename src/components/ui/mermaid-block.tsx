import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import type { MermaidConfig } from 'mermaid'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { copyToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { Copy, Maximize2 } from '@/components/icons/reicon'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

// Mermaid owns global configuration and a render queue. Serialize initialization
// with rendering so diagrams in different messages cannot race on the theme.
let renderQueue: Promise<unknown> = Promise.resolve()
// Mermaid removes any existing element with the render ID, so never reuse one.
let renderCount = 0

// Remounts (session switches, reopened modals) reuse finished SVGs instead
// of running the layout again and changing the message height.
const RENDER_CACHE_LIMIT = 50
const renderCache = new Map<string, string>()

interface RenderResult {
  key: string
  svg?: string
  error?: boolean
}

function cacheSvg(key: string, svg: string) {
  renderCache.delete(key)
  renderCache.set(key, svg)
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    renderCache.delete(renderCache.keys().next().value as string)
  }
}

export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    suppressErrorRendering: true,
    // Pure SVG labels survive sanitization without enabling HTML
    // integration points inside untrusted SVG foreignObjects.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // Untrusted message directives must not weaken security or inject
    // custom global CSS/fonts into the application. Mermaid strips secure
    // keys at every depth, so `htmlLabels` also locks `flowchart.htmlLabels`.
    secure: [
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'maxEdges',
      'suppressErrorRendering',
      'themeCSS',
      'themeVariables',
      'fontFamily',
      'htmlLabels',
    ],
  }
}

export function MermaidBlock({ source }: { source: string }) {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )
  const key = `${dark ? 'dark' : 'light'}:${source}`
  const [result, setResult] = useState<RenderResult>()
  const [showCode, setShowCode] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (renderCache.has(key)) return
    let disposed = false
    const job = renderQueue.then(async () => {
      if (disposed) return
      // Another block with the same source may have rendered it meanwhile.
      const cached = renderCache.get(key)
      if (cached) {
        setResult({ key, svg: cached })
        return
      }
      const container = document.createElement('div')
      container.style.cssText =
        'position:fixed;left:-100000px;top:0;visibility:hidden'
      document.body.appendChild(container)
      try {
        const { default: mermaid } = await import('mermaid')
        if (disposed) return
        mermaid.initialize(mermaidConfig(dark))
        const { svg } = await mermaid.render(
          `mermaid-${++renderCount}`,
          source,
          container
        )
        const safeSvg = DOMPurify.sanitize(svg, {
          FORBID_TAGS: [
            'script',
            'iframe',
            'img',
            'image',
            'a',
            'foreignObject',
          ],
        })
        // WKWebView pageZoom scales em-based SVG text offsets differently from
        // the surrounding geometry. Freeze them in SVG user units while the
        // sanitized diagram is attached and its font metrics are available.
        container.innerHTML = safeSvg
        container.querySelectorAll('text, tspan').forEach(element => {
          const fontSize = parseFloat(getComputedStyle(element).fontSize)
          if (!Number.isFinite(fontSize) || fontSize <= 0) return
          for (const attribute of ['x', 'y', 'dx', 'dy']) {
            const value = element.getAttribute(attribute)
            if (value && /^-?(?:\d+(?:\.\d*)?|\.\d+)em$/.test(value)) {
              element.setAttribute(
                attribute,
                String(parseFloat(value) * fontSize)
              )
            }
          }
        })
        cacheSvg(key, container.innerHTML)
        if (!disposed) setResult({ key, svg: container.innerHTML })
      } catch {
        if (!disposed) setResult({ key, error: true })
      } finally {
        container.remove()
      }
    })
    renderQueue = job.catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [key, source, dark])

  const cachedSvg = renderCache.get(key)
  const current: RenderResult | undefined =
    result?.key === key
      ? result
      : cachedSvg
        ? { key, svg: cachedSvg }
        : undefined
  const diagram = current?.svg ? (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className="min-w-0 overflow-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: current.svg }}
    />
  ) : null

  return (
    <div className="my-5 min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted/30">
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <span className="mr-auto px-2 text-xs text-muted-foreground">
          Mermaid
        </span>
        <ToggleGroup
          type="single"
          value={showCode ? 'code' : 'diagram'}
          onValueChange={value => {
            if (value) setShowCode(value === 'code')
          }}
          aria-label="Diagram view"
          size="sm"
          className="gap-0.5 rounded-md bg-muted p-0.5"
        >
          <ToggleGroupItem
            value="diagram"
            className="rounded-sm px-3 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
          >
            Diagram
          </ToggleGroupItem>
          <ToggleGroupItem
            value="code"
            className="rounded-sm px-3 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
          >
            Code
          </ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-11 text-muted-foreground hover:text-foreground sm:size-8"
              aria-label="Copy code"
              onClick={async () => {
                try {
                  await copyToClipboard(source)
                  toast.success('Copied to clipboard')
                } catch {
                  toast.error('Unable to copy code')
                }
              }}
            >
              <Copy className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy code</TooltipContent>
        </Tooltip>
        {diagram && !showCode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-11 text-muted-foreground hover:text-foreground sm:size-8"
                aria-label="Enlarge diagram"
                onClick={() => setExpanded(true)}
              >
                <Maximize2 className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Enlarge diagram</TooltipContent>
          </Tooltip>
        )}
      </div>
      {current?.error && (
        <p role="alert" className="px-4 pt-3 text-sm text-muted-foreground">
          Unable to render this diagram. The source is shown below.
        </p>
      )}
      {!current && !showCode && (
        <p role="status" className="px-4 pt-3 text-sm text-muted-foreground">
          Rendering diagram…
        </p>
      )}
      {showCode || !diagram ? (
        <pre className="max-w-full overflow-x-auto p-4 text-sm">
          <code>{source}</code>
        </pre>
      ) : (
        diagram
      )}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="max-h-[90dvh] overflow-auto sm:max-w-[90vw]"
          aria-describedby={undefined}
        >
          <DialogTitle>Mermaid diagram</DialogTitle>
          <div className="min-w-0 [&_svg]:min-w-[700px]">{diagram}</div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
