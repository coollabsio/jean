import { memo, useState, useCallback, useRef, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remend from 'remend'
import { Copy, Check, Table } from 'lucide-react'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface MarkdownProps {
  children: string
  /** Enable streaming mode with incomplete markdown handling */
  streaming?: boolean
  className?: string
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText(
      (node as { props: { children?: ReactNode } }).props.children
    )
  }
  return ''
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const text = extractText(children)
    copyToClipboard(text)
    toast.success('Copied to clipboard')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [children])

  return (
    <div className="relative my-5">
      <pre className="overflow-x-auto rounded-lg bg-muted p-4 pr-10 text-sm">
        {children}
      </pre>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="absolute right-2 top-2 opacity-50 hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-background/80 text-muted-foreground hover:text-foreground cursor-pointer"
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy code</TooltipContent>
      </Tooltip>
    </div>
  )
}

function extractTableData(table: HTMLTableElement): string[][] {
  return Array.from(table.querySelectorAll('tr')).map(row =>
    Array.from(row.querySelectorAll('th, td')).map(cell =>
      (cell.textContent ?? '').trim()
    )
  )
}

function tableToTsv(data: string[][]): string {
  return data.map(row => row.join('\t')).join('\n')
}

function tableToMarkdown(data: string[][]): string {
  if (data.length === 0) return ''
  const [header, ...rows] = data
  if (!header) return ''
  const headerLine = `| ${header.join(' | ')} |`
  const separator = `| ${header.map(() => '---').join(' | ')} |`
  const bodyLines = rows.map(row => `| ${row.join(' | ')} |`)
  return [headerLine, separator, ...bodyLines].join('\n')
}

function TableBlock({ children }: { children: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null)
  const [copiedFormat, setCopiedFormat] = useState<'markdown' | 'tsv' | null>(
    null
  )

  const handleCopy = useCallback((format: 'markdown' | 'tsv') => {
    if (!tableRef.current) return
    const data = extractTableData(tableRef.current)
    const text =
      format === 'markdown' ? tableToMarkdown(data) : tableToTsv(data)
    copyToClipboard(text)
    toast.success(
      format === 'markdown' ? 'Copied as Markdown' : 'Copied for spreadsheet'
    )
    setCopiedFormat(format)
    setTimeout(() => setCopiedFormat(null), 2000)
  }, [])

  const btnClass =
    'opacity-50 hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-background/80 text-muted-foreground hover:text-foreground cursor-pointer'

  return (
    <div className="relative my-5 overflow-x-auto">
      <table ref={tableRef} className="min-w-full border-collapse text-sm">
        {children}
      </table>
      <div className="absolute right-2 top-2 flex gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={() => handleCopy('markdown')} className={btnClass}>
              {copiedFormat === 'markdown' ? (
                <Check className="size-4" />
              ) : (
                <Table className="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy as Markdown</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={() => handleCopy('tsv')} className={btnClass}>
              {copiedFormat === 'tsv' ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy for spreadsheet</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

const components: Components = {
  // Headers - clear hierarchy with generous spacing
  h1: ({ children }) => (
    <div className="mt-8 mb-5 text-3xl font-bold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h2: ({ children }) => (
    <div className="mt-8 mb-4 text-2xl font-bold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h3: ({ children }) => (
    <div className="mt-7 mb-3 text-xl font-semibold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h4: ({ children }) => (
    <div className="mt-6 mb-2.5 text-lg font-semibold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h5: ({ children }) => (
    <div className="mt-5 mb-2 text-base font-medium text-foreground first:mt-0">
      {children}
    </div>
  ),
  h6: ({ children }) => (
    <div className="mt-4 mb-1.5 text-sm font-medium text-muted-foreground first:mt-0">
      {children}
    </div>
  ),

  // Emphasis
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,

  // Code - inline and blocks
  code: ({ children, className }) => {
    // Fenced code blocks have a className like "language-js"
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return <code className={className}>{children}</code>
    }
    // Inline code
    return (
      <code className="rounded-md bg-muted px-1.5 py-0.5 text-[0.875em]">
        {children}
      </code>
    )
  },

  // Code blocks
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,

  // Images
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt || ''}
      className="max-w-full h-auto rounded-md my-4"
    />
  ),

  // Links
  a: ({ href, children }) => (
    <a
      href={href}
      className="underline underline-offset-2 hover:text-foreground"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),

  // Lists - generous spacing and indentation
  ul: ({ children }) => (
    <ul className="my-4 ml-6 list-disc list-outside space-y-2">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 ml-6 list-decimal list-outside space-y-2">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  // Blockquotes - more prominent
  blockquote: ({ children }) => (
    <blockquote className="my-5 border-l-2 border-muted-foreground/40 pl-4 py-1 italic">
      {children}
    </blockquote>
  ),

  // Paragraphs - more breathing room
  p: ({ children }) => (
    <p className="my-3 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),

  // Tables
  table: ({ children }) => <TableBlock>{children}</TableBlock>,
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-border">{children}</tr>,
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="px-4 py-2.5">{children}</td>,
}

const streamingComponents: Components = {
  ...components,
  p: ({ children }) => (
    <p className="my-0 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
}

/**
 * Memoized markdown renderer to prevent expensive re-parsing
 * ReactMarkdown is expensive, so we avoid re-renders when content hasn't changed
 */
const Markdown = memo(function Markdown({
  children,
  streaming = false,
  className,
}: MarkdownProps) {
  // Apply remend preprocessing for streaming content to auto-close incomplete markdown
  const content = streaming ? remend(children) : children

  return (
    <div className={cn('markdown leading-relaxed break-words', className)}>
      <ReactMarkdown
        components={streaming ? streamingComponents : components}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

export { Markdown }
