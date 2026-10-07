import {
  lazy,
  Suspense,
  memo,
  useState,
  useEffect,
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
import { remarkFixInterruptedLists } from '@/lib/remark-fix-interrupted-lists'
import { Copy, Check, ListChecks, Thumbtack } from '@/components/icons/reicon'
import { MarkdownIcon } from '@/components/icons/MarkdownIcon'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import { extractFilePath, openLocalFile } from '@/lib/local-file'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { convertServerFileSrc, invokeForOptionalServer } from '@/lib/transport'
import { parseServerResourceKey } from '@/lib/server-resource'
import { tableToMarkdown, setTableRowInPrompt } from '@/lib/table-rows-prompt'

const MermaidBlock = lazy(() =>
  import('./mermaid-block').then(module => ({ default: module.MermaidBlock }))
)
const MarkdownStreamingContext = createContext(false)

interface MarkdownProps {
  children: string
  /**
   * Enable streaming mode: auto-closes incomplete markdown and skips the
   * expensive rehype-raw HTML pass (raw HTML shows as literal text until the
   * completed message re-renders without `streaming`).
   */
  streaming?: boolean
  className?: string
  /** Rendering context (tool-call keeps the same ordered-list gutter as chat). */
  variant?: 'chat' | 'tool-call'
  /** Chat message ID — enables per-table checklist persistence when set */
  messageId?: string
  /** Owning session ID — required alongside messageId for checklist persistence */
  sessionId?: string
  /** Smaller mobile heading + spacing for narrow modal contexts */
  compact?: boolean
  /**
   * Fixed key for every table in this markdown. Used to render a pinned table
   * outside its message so checklist and pin state stay shared.
   */
  tableKey?: string
}

interface MarkdownTableContextValue {
  messageId: string | null
  sessionId: string | null
  tableKey: string | null
  source: string
}

const MarkdownTableContext = createContext<MarkdownTableContextValue>({
  messageId: null,
  sessionId: null,
  tableKey: null,
  source: '',
})

interface TableRowsContextValue {
  /** Checked row indices, or null when checklist mode is off */
  checkedRows: Set<number> | null
  onToggle: (rowIndex: number) => void
  /** Rows added to the prompt chip, or null when rows cannot be added */
  promptRows: Set<number> | null
  /** Notes for rows in the prompt chip, by row index */
  promptNotes: Record<number, string>
  /** Add or update a row in the prompt; `note === null` removes it */
  onSetPromptRow: (rowIndex: number, note: string | null) => void
}

const TableRowsContext = createContext<TableRowsContextValue>({
  checkedRows: null,
  onToggle: () => undefined,
  promptRows: null,
  promptNotes: {},
  onSetPromptRow: () => undefined,
})

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

function openLocalFileLink(href: string | undefined): boolean {
  if (!href || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href)) {
    return false
  }

  let path = href
  try {
    path = decodeURIComponent(href)
  } catch {
    // Malformed percent-escape (e.g. a lone `%`) — use the raw href
  }
  return openLocalFile(path)
}

function handleFilePathClick(event: React.MouseEvent<HTMLElement>) {
  // Keep drag-to-select usable: only a plain click opens the file.
  if (window.getSelection()?.toString().trim()) return
  const path = event.currentTarget.dataset.filePath
  if (path && !openLocalFile(path)) toast.error('Cannot resolve file path')
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const streaming = useContext(MarkdownStreamingContext)
  const code = Children.toArray(children)[0]
  const isMermaid =
    isValidElement<{ className?: string }>(code) &&
    code.props.className?.split(/\s+/).includes('language-mermaid')

  const handleCopy = useCallback(() => {
    const text = extractText(children)
    copyToClipboard(text)
    toast.success('Copied to clipboard')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [children])

  if (isMermaid && !streaming) {
    return (
      <Suspense
        fallback={
          <pre className="my-5 overflow-x-auto rounded-lg bg-muted p-4 text-sm">
            {children}
          </pre>
        }
      >
        <MermaidBlock source={extractText(children)} />
      </Suspense>
    )
  }

  return (
    <div className="relative my-5 min-w-0 max-w-full">
      <pre className="max-w-full overflow-x-auto rounded-lg bg-muted p-4 pr-10 text-sm">
        {children}
      </pre>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy code"
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
    Array.from(row.querySelectorAll('th, td')).flatMap(cell =>
      (cell as HTMLElement).dataset.checklistCell
        ? []
        : [(cell.textContent ?? '').trim()]
    )
  )
}

function tableToTsv(data: string[][]): string {
  return data.map(row => row.join('\t')).join('\n')
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const { sessionId } = useContext(MarkdownTableContext)
  const serverId = sessionId
    ? parseServerResourceKey(sessionId)?.serverId
    : undefined
  const isUrl = !src || /^(https?:|data:|blob:|asset:|\/api\/|#)/i.test(src)
  const isAppData = Boolean(src && /com\.jean\.desktop[/\\]/.test(src))
  const [loadedImage, setLoadedImage] = useState<{
    path: string
    serverId?: string
    url: string
  } | null>(null)

  // Screenshots can live outside app data and project roots (for example /tmp).
  // Use the same owner-routed file reader as the file viewer for those paths.
  useEffect(() => {
    if (!src || isUrl || isAppData) return
    let cancelled = false
    void invokeForOptionalServer<{ mimeType: string; data: string }>(
      serverId,
      'read_file_base64',
      { path: src }
    )
      .then(result => {
        if (!cancelled) {
          setLoadedImage({
            path: src,
            serverId,
            url: `data:${result.mimeType};base64,${result.data}`,
          })
        }
      })
      .catch(error => {
        if (!cancelled) console.error('Failed to load markdown image:', error)
      })
    return () => {
      cancelled = true
    }
  }, [src, serverId, isUrl, isAppData])

  const imageSrc = isUrl
    ? src
    : isAppData && src
      ? convertServerFileSrc(serverId, src)
      : loadedImage?.path === src && loadedImage?.serverId === serverId
        ? loadedImage.url
        : undefined

  return (
    <img
      src={imageSrc}
      alt={alt || ''}
      className="max-w-full h-auto rounded-md my-4"
    />
  )
}

/**
 * Prepend leading cells into a row by cloning the tr element. Each leading
 * cell must carry data-checklist-cell so extraction ignores it for markdown /
 * TSV copy.
 */
function cloneRowWithLeadingCells(
  row: ReactNode,
  leading: ReactNode[]
): ReactNode {
  if (!isValidElement(row) || leading.length === 0) return row
  const rowEl = row as ReactElement<{ children?: ReactNode }>
  const original = rowEl.props.children
  return cloneElement(rowEl, {}, [...leading, original])
}

const CHECKLIST_THEAD_LEADING = (
  <th
    key="__checklist__"
    data-checklist-cell="true"
    className="w-10 px-2"
    aria-hidden
  />
)

/** Clicks on these elements keep their own action and do not pick the row. */
const ROW_CLICK_IGNORE =
  'a, button, input, textarea, label, [role="checkbox"], [data-file-path]'

interface PromptRowProps {
  row: ReactElement<{ className?: string }>
  rowIndex: number
  inPrompt: boolean
  note: string
  onSave: (rowIndex: number, note: string | null) => void
}

/** Move focus to the previous or next prompt row in the same table body. */
function focusSiblingRow(row: HTMLElement, step: 1 | -1) {
  const sibling =
    step === 1 ? row.nextElementSibling : row.previousElementSibling
  if (sibling instanceof HTMLElement) sibling.focus()
}

/**
 * Table row that adds itself to the prompt chip on click, then opens a small
 * form under the row for an optional note. A click on a row that is already
 * in the prompt opens the same form to edit the note or remove the row.
 *
 * Keyboard: Up/Down move between rows, Enter opens the note form (a second
 * Enter adds the row to the prompt), Delete/Backspace remove the row.
 */
function PromptRow({ row, rowIndex, inPrompt, note, onSave }: PromptRowProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note)
  const rowRef = useRef<HTMLElement>(null)
  const rowNumber = rowIndex + 1

  const openForm = (addNow: boolean) => {
    if (addNow && !inPrompt) onSave(rowIndex, '')
    setDraft(note)
    setOpen(true)
  }
  const saveNote = () => {
    if (!inPrompt || draft.trim() !== note) onSave(rowIndex, draft)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {cloneElement(row, {
          ref: rowRef,
          className: cn(
            row.props.className,
            'cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
            inPrompt
              ? 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)] hover:bg-primary/15'
              : 'hover:bg-muted/50 focus-visible:bg-muted/50'
          ),
          tabIndex: 0,
          'aria-selected': inPrompt,
          title: note || undefined,
          onClick: (event: React.MouseEvent<HTMLElement>) => {
            const target = event.target as HTMLElement
            if (target.closest(ROW_CLICK_IGNORE)) return
            if (window.getSelection()?.toString()) return
            openForm(true)
          },
          onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            if (event.target !== event.currentTarget) return
            if (event.metaKey || event.ctrlKey || event.altKey) return
            const row = event.currentTarget
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              focusSiblingRow(row, event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'Enter' || event.key === ' ') {
              openForm(false)
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
              if (inPrompt) onSave(rowIndex, null)
            } else {
              return
            }
            event.preventDefault()
            event.stopPropagation()
          },
        } as Record<string, unknown>)}
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        onCloseAutoFocus={event => {
          // Return focus to the row so keyboard navigation can continue.
          event.preventDefault()
          rowRef.current?.focus({ preventScroll: true })
        }}
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault()
            saveNote()
          }}
        >
          <label
            htmlFor={`prompt-row-note-${rowIndex}`}
            className="text-xs font-medium text-muted-foreground"
          >
            {inPrompt
              ? `Row ${rowNumber} is in the prompt. Add a note (optional)`
              : `Add row ${rowNumber} to the prompt. Note (optional)`}
          </label>
          <Textarea
            id={`prompt-row-note-${rowIndex}`}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                saveNote()
              }
            }}
            placeholder="e.g. Fix this one first"
            className="min-h-16 text-sm"
            autoFocus
            onFocus={event => {
              const end = event.currentTarget.value.length
              event.currentTarget.setSelectionRange(end, end)
            }}
          />
          <div className="flex justify-end gap-2">
            {inPrompt && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onSave(rowIndex, null)
                  setOpen(false)
                }}
              >
                Remove
              </Button>
            )}
            <Button type="submit" size="sm">
              {inPrompt ? 'Save' : 'Add'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function ChecklistAwareThead({ children }: { children?: ReactNode }) {
  const { checkedRows } = useContext(TableRowsContext)
  const augmented = checkedRows
    ? Children.map(children, row =>
        cloneRowWithLeadingCells(row, [CHECKLIST_THEAD_LEADING])
      )
    : children
  return <thead className="bg-muted/50">{augmented}</thead>
}

function ChecklistAwareTbody({ children }: { children?: ReactNode }) {
  const { checkedRows, onToggle, promptRows, promptNotes, onSetPromptRow } =
    useContext(TableRowsContext)
  if (!checkedRows && !promptRows) {
    return <tbody>{children}</tbody>
  }
  let rowIdx = 0
  const augmented = Children.map(children, row => {
    if (!isValidElement(row)) return row
    const idx = rowIdx++
    const withCells = checkedRows
      ? cloneRowWithLeadingCells(row, [
          <td
            key="__checklist__"
            data-checklist-cell="true"
            className="w-10 px-2 align-middle"
          >
            <Checkbox
              checked={checkedRows.has(idx)}
              onCheckedChange={() => onToggle(idx)}
              aria-label={`Toggle row ${idx + 1}`}
              className="cursor-pointer"
            />
          </td>,
        ])
      : row
    if (!promptRows) return withCells
    return (
      <PromptRow
        key={idx}
        row={withCells as ReactElement<{ className?: string }>}
        rowIndex={idx}
        inPrompt={promptRows.has(idx)}
        note={promptNotes[idx] ?? ''}
        onSave={onSetPromptRow}
      />
    )
  })
  return <tbody>{augmented}</tbody>
}

const NO_TABLE_ROWS = { rows: [] as number[], notes: undefined }
const NO_NOTES: Record<number, string> = {}

/**
 * Text of the nearest heading (`## Title` or a bold-only `**Title**` line)
 * before `offset` in the markdown source. Used as the pinned table title.
 */
export function headingBefore(source: string, offset: number): string | null {
  const lines = source.slice(0, offset).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    const match =
      /^#{1,6}\s+(.+?)\s*#*$/.exec(line) ?? /^\*\*(.+)\*\*:?$/.exec(line)
    if (!match?.[1]) continue
    const text = match[1].replace(/[*_`]/g, '').replace(/:$/, '').trim()
    if (text) return text
  }
  return null
}

interface TableBlockProps {
  children: ReactNode
  tableOffset: number
  tableEndOffset: number | undefined
}

function TableBlock({
  children,
  tableOffset,
  tableEndOffset,
}: TableBlockProps) {
  const tableRef = useRef<HTMLTableElement>(null)
  const isMobile = useIsMobile()
  const [copiedFormat, setCopiedFormat] = useState<'markdown' | 'tsv' | null>(
    null
  )

  const {
    messageId,
    sessionId: ctxSessionId,
    tableKey: fixedTableKey,
    source,
  } = useContext(MarkdownTableContext)
  const tableKey =
    fixedTableKey ?? (messageId ? `${messageId}:${tableOffset}` : null)

  const storeSessionId = useChatStore(state => {
    if (state.activeWorktreeId) {
      return state.activeSessionIds[state.activeWorktreeId] ?? null
    }
    return null
  })
  const sessionId = ctxSessionId ?? storeSessionId
  const checkedRows = useChatStore(state =>
    sessionId &&
    tableKey &&
    !state.hiddenTableChecklists[sessionId]?.includes(tableKey)
      ? (state.tableCheckedRows[sessionId]?.[tableKey] ?? null)
      : null
  )
  const checklistEnabled = checkedRows !== null
  const canUseChecklist = Boolean(sessionId && tableKey)
  const promptTableRows = useChatStore(state =>
    sessionId && tableKey
      ? (state.pendingTextFiles[sessionId]?.find(
          tf => tf.tableRows?.tableKey === tableKey
        )?.tableRows ?? NO_TABLE_ROWS)
      : null
  )
  const promptRows = useMemo(
    () => (promptTableRows ? new Set(promptTableRows.rows) : null),
    [promptTableRows]
  )
  const isPinned = useChatStore(state =>
    sessionId && tableKey
      ? (state.pinnedTables[sessionId]?.some(p => p.key === tableKey) ?? false)
      : false
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

  const handleToggleChecklist = useCallback(() => {
    if (!sessionId || !tableKey) return
    const store = useChatStore.getState()
    const hidden = store.hiddenTableChecklists[sessionId]?.includes(tableKey)
    if (store.tableCheckedRows[sessionId]?.[tableKey] && !hidden) {
      store.disableTableChecklist(sessionId, tableKey)
    } else {
      store.enableTableChecklist(sessionId, tableKey)
    }
  }, [sessionId, tableKey])

  const handleTogglePin = useCallback(() => {
    if (!sessionId || !tableKey) return
    const fromSource =
      tableEndOffset !== undefined
        ? source.slice(tableOffset, tableEndOffset).trim()
        : ''
    const markdown =
      fromSource ||
      (tableRef.current
        ? tableToMarkdown(extractTableData(tableRef.current))
        : '')
    const title = headingBefore(source, tableOffset)
    useChatStore.getState().togglePinnedTable(sessionId, {
      key: tableKey,
      markdown,
      ...(title ? { title } : {}),
    })
  }, [sessionId, tableKey, source, tableOffset, tableEndOffset])

  const handleSetPromptRow = useCallback(
    (rowIndex: number, note: string | null) => {
      if (!sessionId || !tableKey || !tableRef.current) return
      // Adding a row to the prompt also checks it in the table checklist,
      // even when checklist mode is off (the check shows once it is on).
      if (note !== null) {
        useChatStore.getState().checkTableRow(sessionId, tableKey, rowIndex)
      }
      void setTableRowInPrompt(
        sessionId,
        tableKey,
        rowIndex,
        extractTableData(tableRef.current),
        note
      )
    },
    [sessionId, tableKey]
  )

  const handleToggleRow = useCallback(
    (rowIndex: number) => {
      if (!sessionId || !tableKey) return
      useChatStore
        .getState()
        .toggleTableRowChecked(sessionId, tableKey, rowIndex)
    },
    [sessionId, tableKey]
  )

  const rowsCtxValue = useMemo(
    () => ({
      checkedRows,
      onToggle: handleToggleRow,
      promptRows,
      promptNotes: promptTableRows?.notes ?? NO_NOTES,
      onSetPromptRow: handleSetPromptRow,
    }),
    [
      checkedRows,
      handleToggleRow,
      promptRows,
      promptTableRows,
      handleSetPromptRow,
    ]
  )

  const btnClass =
    'opacity-50 hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-background/80 text-muted-foreground hover:text-foreground cursor-pointer'
  const activeBtnClass =
    'opacity-100 transition-opacity p-1.5 rounded-md bg-background/80 text-foreground cursor-pointer'

  return (
    <div
      className="my-5 scroll-mt-12 rounded-md"
      data-table-key={tableKey ?? undefined}
    >
      <div className="mb-2 flex items-center justify-end gap-0.5">
        {promptRows && (
          <span className="mr-auto text-xs text-muted-foreground">
            {isMobile ? 'Tap' : 'Click'} a row to add it to the prompt
          </span>
        )}
        {canUseChecklist && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleTogglePin}
                className={isPinned ? activeBtnClass : btnClass}
                aria-label={isPinned ? 'Unpin table' : 'Pin table'}
                aria-pressed={isPinned}
              >
                <Thumbtack
                  className="size-4"
                  weight={isPinned ? 'Filled' : 'Outline'}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {isPinned ? 'Unpin table' : 'Pin table'}
            </TooltipContent>
          </Tooltip>
        )}
        {canUseChecklist && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleToggleChecklist}
                className={checklistEnabled ? activeBtnClass : btnClass}
                aria-label={
                  checklistEnabled ? 'Turn off checklist' : 'Toggle checklist'
                }
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
            <button
              type="button"
              onClick={() => handleCopy('markdown')}
              aria-label="Copy as Markdown"
              className={btnClass}
            >
              {copiedFormat === 'markdown' ? (
                <Check className="size-4" />
              ) : (
                <MarkdownIcon className="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy as Markdown</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => handleCopy('tsv')}
              aria-label="Copy for spreadsheet"
              className={btnClass}
            >
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
        <TableRowsContext.Provider value={rowsCtxValue}>
          <table ref={tableRef} className="min-w-full border-collapse text-sm">
            {children}
          </table>
        </TableRowsContext.Provider>
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
    // Inline code. File paths open in the file viewer on click, and get
    // Open/Download items in the message context menu
    // (see MessageThreadContextMenu).
    const filePath =
      typeof children === 'string' ? extractFilePath(children) : null
    return (
      <code
        className={cn(
          'rounded-md bg-muted px-1.5 py-0.5 text-[0.875em]',
          filePath &&
            'underline decoration-dotted underline-offset-2 hover:text-foreground'
        )}
        data-file-path={filePath ?? undefined}
        onClick={filePath ? handleFilePathClick : undefined}
      >
        {children}
      </code>
    )
  },

  // Code blocks
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,

  // Images
  img: MarkdownImage,

  // Links
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={event => {
        if (openLocalFileLink(href)) event.preventDefault()
      }}
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
  // pl-8 (not pl-6): double-digit markers ("10.") need extra gutter width when
  // list-outside paints into padding; chat parents use overflow-x-hidden and
  // otherwise clip the tens digit to ".0", ".1" (issue #542). tool-call keeps
  // the same width for consistency.
  ol: ({ children, className, ...props }) => (
    <ol
      {...props}
      className={cn('my-4 pl-8 list-decimal list-outside space-y-2', className)}
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

  // Paragraphs - more breathing room. whitespace-pre-wrap keeps single spaces
  // visible if a stream left odd mid-token spacing; ligatures off avoids fonts
  // visually merging fragments (Grok ACP emits many tiny word pieces).
  p: ({ children }) => (
    <p className="my-3 leading-relaxed first:mt-0 last:mb-0 whitespace-pre-wrap [font-variant-ligatures:none]">
      {children}
    </p>
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
    return (
      <TableBlock
        tableOffset={offset}
        tableEndOffset={node?.position?.end?.offset}
      >
        {children}
      </TableBlock>
    )
  },
  thead: ({ children }) => (
    <ChecklistAwareThead>{children}</ChecklistAwareThead>
  ),
  tbody: ({ children }) => (
    <ChecklistAwareTbody>{children}</ChecklistAwareTbody>
  ),
  // Spread props so PromptRow can add its click handler and row classes.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tr: ({ children, className, node, ...props }) => (
    <tr {...props} className={cn('border-b border-border', className)}>
      {children}
    </tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="px-4 py-2.5">{children}</td>,
}

const streamingComponents: Components = {
  ...components,
  // whitespace-pre-wrap keeps mid-stream spaces visible under rapid reparse
  // (Grok emits many tiny word fragments per frame). Ligatures off avoids
  // fonts collapsing adjacent tokens visually while text is still settling.
  p: ({ children }) => (
    <p className="my-0 leading-relaxed first:mt-0 last:mb-0 whitespace-pre-wrap [font-variant-ligatures:none]">
      {children}
    </p>
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
    <p className="my-0 leading-relaxed first:mt-0 last:mb-0 whitespace-pre-wrap [font-variant-ligatures:none]">
      {children}
    </p>
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

// Module-level plugin arrays keep references stable across renders.
// remarkFixInterruptedLists runs after GFM so task lists are already parsed,
// then nests orphan sibling ULs under the preceding OL item (issue #200).
const remarkPlugins = [remarkGfm, remarkFixInterruptedLists]
// rehype-raw re-parses the full accumulated text as HTML on every render —
// the dominant per-frame cost while streaming — so streaming mode skips it
// and only completed (non-streaming) renders apply it.
const rehypePlugins = [rehypeRaw]

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
  tableKey,
}: MarkdownProps) {
  // Apply remend preprocessing for streaming content to auto-close incomplete
  // markdown. remend strips a single trailing space (incomplete-markdown
  // heuristic) — restore it so space-bearing stream tails don't disappear
  // mid-token when the next delta is delayed.
  const content = streaming
    ? (() => {
        const hadTrailingSpace =
          children.endsWith(' ') && !children.endsWith('  ')
        const repaired = remend(children)
        return hadTrailingSpace && !repaired.endsWith(' ')
          ? `${repaired} `
          : repaired
      })()
    : children

  const contextValue = useMemo(
    () => ({
      messageId: messageId ?? null,
      sessionId: sessionId ?? null,
      tableKey: tableKey ?? null,
      source: content,
    }),
    [messageId, sessionId, tableKey, content]
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
      <MarkdownStreamingContext.Provider value={streaming}>
        <MarkdownTableContext.Provider value={contextValue}>
          <ReactMarkdown
            components={componentsToUse}
            remarkPlugins={remarkPlugins}
            rehypePlugins={streaming ? undefined : rehypePlugins}
          >
            {content}
          </ReactMarkdown>
        </MarkdownTableContext.Provider>
      </MarkdownStreamingContext.Provider>
    </div>
  )
})

export { Markdown }
