import {
  memo,
  useState,
  useCallback,
  useRef,
  useMemo,
  useContext,
  createContext,
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remend from 'remend'
import { Copy, Check, Table, ListChecks } from 'lucide-react'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { convertFileSrc } from '@/lib/transport'

interface MarkdownProps {
  children: string
  /** Enable streaming mode with incomplete markdown handling */
  streaming?: boolean
  className?: string
  /** Rendering context; tool-call markdown needs a wider ordered-list gutter. */
  variant?: 'chat' | 'tool-call'
  /** Chat message ID — enables per-table checklist persistence when set */
  messageId?: string
  /** Owning session ID — required alongside messageId for checklist persistence */
  sessionId?: string
  /** Smaller mobile heading + spacing for narrow modal contexts */
  compact?: boolean
}

interface MarkdownTableContextValue {
  messageId: string | null
  sessionId: string | null
}

const MarkdownTableContext = createContext<MarkdownTableContextValue>({
  messageId: null,
  sessionId: null,
})

interface ChecklistInjectionContextValue {
  checkedRows: Set<number> | null
  onToggle: (rowIndex: number) => void
}

const ChecklistInjectionContext = createContext<ChecklistInjectionContextValue>(
  {
    checkedRows: null,
    onToggle: () => undefined,
  }
)

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
    <div className="relative my-5 min-w-0 max-w-full">
      <pre className="max-w-full overflow-x-auto rounded-lg bg-muted p-4 pr-10 text-sm">
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
    Array.from(row.querySelectorAll('th, td'))
      .filter(cell => !(cell as HTMLElement).dataset.checklistCell)
      .map(cell => (cell.textContent ?? '').trim())
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

function markdownImageSrc(src: string | undefined): string | undefined {
  if (!src) return src
  if (/^(https?:|data:|blob:|asset:|\/api\/|#)/i.test(src)) return src
  return convertFileSrc(src)
}

/**
 * Prepend a leading checkbox cell into a row by cloning the tr element and
 * injecting the new cell before the original children. `leading` must be a
 * cell element (th/td) carrying data-checklist-cell so extraction ignores it
 * for markdown / TSV copy.
 */
function cloneRowWithLeadingCell(
  row: ReactNode,
  leading: ReactNode
): ReactNode {
  if (!isValidElement(row)) return row
  const rowEl = row as ReactElement<{ children?: ReactNode }>
  const original = rowEl.props.children
  return cloneElement(rowEl, {}, [leading, original])
}

function ChecklistAwareThead({ children }: { children?: ReactNode }) {
  const { checkedRows } = useContext(ChecklistInjectionContext)
  if (!checkedRows) {
    return <thead className="bg-muted/50">{children}</thead>
  }
  const leading = (
    <th
      key="__checklist__"
      data-checklist-cell="true"
      className="w-10 px-2"
      aria-hidden
    />
  )
  const augmented = Children.map(children, row =>
    cloneRowWithLeadingCell(row, leading)
  )
  return <thead className="bg-muted/50">{augmented}</thead>
}

function ChecklistAwareTbody({ children }: { children?: ReactNode }) {
  const { checkedRows, onToggle } = useContext(ChecklistInjectionContext)
  if (!checkedRows) {
    return <tbody>{children}</tbody>
  }
  let rowIdx = 0
  const augmented = Children.map(children, row => {
    if (!isValidElement(row)) return row
    const idx = rowIdx++
    const isChecked = checkedRows.has(idx)
    const leading = (
      <td
        key="__checklist__"
        data-checklist-cell="true"
        className="w-10 px-2 align-middle"
      >
        <Checkbox
          checked={isChecked}
          onCheckedChange={() => onToggle(idx)}
          aria-label={`Toggle row ${idx + 1}`}
          className="cursor-pointer"
        />
      </td>
    )
    return cloneRowWithLeadingCell(row, leading)
  })
  return <tbody>{augmented}</tbody>
}

interface TableBlockProps {
  children: ReactNode
  tableOffset: number
}

function TableBlock({ children, tableOffset }: TableBlockProps) {
  const tableRef = useRef<HTMLTableElement>(null)
  const [copiedFormat, setCopiedFormat] = useState<'markdown' | 'tsv' | null>(
    null
  )

  const { messageId, sessionId: ctxSessionId } =
    useContext(MarkdownTableContext)
  const tableKey = messageId ? `${messageId}:${tableOffset}` : null

  const storeSessionId = useChatStore(state => {
    if (state.activeWorktreeId) {
      return state.activeSessionIds[state.activeWorktreeId] ?? null
    }
    return null
  })
  const sessionId = ctxSessionId ?? storeSessionId
  const checkedRows = useChatStore(state =>
    sessionId && tableKey
      ? (state.tableCheckedRows[sessionId]?.[tableKey] ?? null)
      : null
  )
  const checklistEnabled = checkedRows !== null
  const canUseChecklist = Boolean(sessionId && tableKey)

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

  const handleToggleChecklist = useCallback(() => {
    if (!sessionId || !tableKey) return
    const store = useChatStore.getState()
    if (store.tableCheckedRows[sessionId]?.[tableKey]) {
      store.disableTableChecklist(sessionId, tableKey)
    } else {
      store.enableTableChecklist(sessionId, tableKey)
    }
  }, [sessionId, tableKey])

  const handleToggleRow = useCallback(
    (rowIndex: number) => {
      if (!sessionId || !tableKey) return
      useChatStore
        .getState()
        .toggleTableRowChecked(sessionId, tableKey, rowIndex)
    },
    [sessionId, tableKey]
  )

  const checklistCtxValue = useMemo(
    () => ({ checkedRows, onToggle: handleToggleRow }),
    [checkedRows, handleToggleRow]
  )

  const btnClass =
    'opacity-50 hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-background/80 text-muted-foreground hover:text-foreground cursor-pointer'
  const activeBtnClass =
    'opacity-100 transition-opacity p-1.5 rounded-md bg-background/80 text-foreground cursor-pointer'

  return (
    <div className="my-5">
      <div className="mb-2 flex justify-end gap-0.5">
        {canUseChecklist && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleToggleChecklist}
                className={checklistEnabled ? activeBtnClass : btnClass}
                aria-pressed={checklistEnabled}
              >
                <ListChecks className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {checklistEnabled ? 'Turn off checklist' : 'Toggle checklist'}
            </TooltipContent>
          </Tooltip>
        )}
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
      <div className="overflow-x-auto">
        <ChecklistInjectionContext.Provider value={checklistCtxValue}>
          <table ref={tableRef} className="min-w-full border-collapse text-sm">
            {children}
          </table>
        </ChecklistInjectionContext.Provider>
      </div>
    </div>
  )
}

const components: Components = {
  // Headers - clear hierarchy with generous spacing
  h1: ({ children }) => (
    <div className="mt-6 mb-4 text-xl sm:text-3xl sm:mt-8 sm:mb-5 font-bold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h2: ({ children }) => (
    <div className="mt-6 mb-3 text-lg sm:text-2xl sm:mt-8 sm:mb-4 font-bold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h3: ({ children }) => (
    <div className="mt-5 mb-2 text-base sm:text-xl sm:mt-7 sm:mb-3 font-semibold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h4: ({ children }) => (
    <div className="mt-4 mb-2 text-sm sm:text-lg sm:mt-6 sm:mb-2.5 font-semibold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h5: ({ children }) => (
    <div className="mt-4 mb-1.5 text-sm sm:text-base sm:mt-5 sm:mb-2 font-medium text-foreground first:mt-0">
      {children}
    </div>
  ),
  h6: ({ children }) => (
    <div className="mt-3 mb-1 text-xs sm:text-sm sm:mt-4 sm:mb-1.5 font-medium text-muted-foreground first:mt-0">
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
      src={markdownImageSrc(src)}
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
  ul: ({ children, className, ...props }) => (
    <ul
      {...props}
      className={cn('my-4 pl-6 list-disc list-outside space-y-2', className)}
    >
      {children}
    </ul>
  ),
  ol: ({ children, className, ...props }) => (
    <ol
      {...props}
      className={cn('my-4 pl-6 list-decimal list-outside space-y-2', className)}
    >
      {children}
    </ol>
  ),
  li: ({ children, className, ...props }) => (
    <li {...props} className={cn('leading-relaxed', className)}>
      {children}
    </li>
  ),

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

  // Task list checkboxes (from remark-gfm) → shadcn Checkbox for theme-aware styling
  input: ({ type, checked, ...props }) => {
    if (type === 'checkbox') {
      return (
        <Checkbox
          checked={!!checked}
          tabIndex={-1}
          aria-readonly
          className="mt-0.5 pointer-events-none"
        />
      )
    }
    return <input type={type} checked={checked} {...props} />
  },

  // Tables
  table: ({ children, node }) => {
    const offset = node?.position?.start?.offset ?? 0
    return <TableBlock tableOffset={offset}>{children}</TableBlock>
  },
  thead: ({ children }) => (
    <ChecklistAwareThead>{children}</ChecklistAwareThead>
  ),
  tbody: ({ children }) => (
    <ChecklistAwareTbody>{children}</ChecklistAwareTbody>
  ),
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

const toolCallComponents: Components = {
  ...components,
  ol: ({ children, className, ...props }) => (
    <ol
      {...props}
      className={cn('my-4 pl-8 list-decimal list-outside space-y-2', className)}
    >
      {children}
    </ol>
  ),
}

const toolCallStreamingComponents: Components = {
  ...toolCallComponents,
  p: ({ children }) => (
    <p className="my-0 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
}

const compactComponents: Components = {
  ...components,
  h1: ({ children }) => (
    <div className="mt-6 mb-4 text-base md:text-3xl md:mt-8 md:mb-5 font-bold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h2: ({ children }) => (
    <div className="mt-6 mb-3 text-sm md:text-2xl md:mt-8 md:mb-4 font-bold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h3: ({ children }) => (
    <div className="mt-5 mb-2 text-sm md:text-xl md:mt-7 md:mb-3 font-semibold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h4: ({ children }) => (
    <div className="mt-4 mb-2 text-xs md:text-lg md:mt-6 md:mb-2.5 font-semibold text-foreground first:mt-0">
      {children}
    </div>
  ),
  h5: ({ children }) => (
    <div className="mt-4 mb-1.5 text-xs md:text-base md:mt-5 md:mb-2 font-medium text-foreground first:mt-0">
      {children}
    </div>
  ),
  h6: ({ children }) => (
    <div className="mt-3 mb-1 text-xs md:text-sm md:mt-4 md:mb-1.5 font-medium text-muted-foreground first:mt-0">
      {children}
    </div>
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
  variant = 'chat',
  messageId,
  sessionId,
  compact = false,
}: MarkdownProps) {
  // Apply remend preprocessing for streaming content to auto-close incomplete markdown
  const content = streaming ? remend(children) : children

  const contextValue = useMemo(
    () => ({ messageId: messageId ?? null, sessionId: sessionId ?? null }),
    [messageId, sessionId]
  )

  const componentsToUse = streaming
    ? variant === 'tool-call'
      ? toolCallStreamingComponents
      : streamingComponents
    : compact
      ? compactComponents
      : variant === 'tool-call'
        ? toolCallComponents
        : components

  return (
    <div className={cn('markdown leading-relaxed break-words', className)}>
      <MarkdownTableContext.Provider value={contextValue}>
        <ReactMarkdown
          components={componentsToUse}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]}
        >
          {content}
        </ReactMarkdown>
      </MarkdownTableContext.Provider>
    </div>
  )
})

export { Markdown }
