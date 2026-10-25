import { useRef, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { copyToClipboard, readFromClipboard } from '@/lib/clipboard'

type EditableField = HTMLInputElement | HTMLTextAreaElement

function fieldFromEvent(event: React.MouseEvent): EditableField | null {
  const target = event.currentTarget
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return target
  }
  if (!(target instanceof Element)) return null
  const field = target.querySelector('input, textarea')
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    return field
  }
  return null
}

/** Update a controlled input and notify React. */
function replaceFieldRange(
  field: EditableField,
  start: number,
  end: number,
  insert: string
) {
  const next = field.value.slice(0, start) + insert + field.value.slice(end)
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(field, next)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  const caret = start + insert.length
  field.setSelectionRange(caret, caret)
}

/** Cut / Copy / Paste for the sidebar search field, instead of the webview menu. */
export function SearchFieldContextMenu({
  children,
}: {
  children: ReactElement
}) {
  const fieldRef = useRef<EditableField | null>(null)
  const rangeRef = useRef({ start: 0, end: 0 })
  const [hasSelection, setHasSelection] = useState(false)

  const captureSelection = (event: React.MouseEvent) => {
    const field = fieldFromEvent(event)
    if (!field) return
    fieldRef.current = field
    const start = field.selectionStart ?? 0
    const end = field.selectionEnd ?? 0
    rangeRef.current = { start, end }
    setHasSelection(end > start)
  }

  const copySelection = async () => {
    const field = fieldRef.current
    if (!field) return null
    const { start, end } = rangeRef.current
    if (end <= start) return null
    const text = field.value.slice(start, end)
    await copyToClipboard(text)
    return { field, start, end }
  }

  const cut = () => {
    void copySelection()
      .then(selection => {
        if (!selection) return
        replaceFieldRange(selection.field, selection.start, selection.end, '')
      })
      .catch(() => toast.error('Failed to cut'))
  }

  const copy = () => {
    void copySelection().catch(() => toast.error('Failed to copy'))
  }

  const paste = () => {
    const field = fieldRef.current
    if (!field) return
    const { start, end } = rangeRef.current
    void readFromClipboard()
      .then(text => replaceFieldRange(field, start, end, text))
      .catch(() => toast.error('Failed to paste'))
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={captureSelection}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-36">
        <ContextMenuItem disabled={!hasSelection} onSelect={cut}>
          Cut
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={copy}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem onSelect={paste}>Paste</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
