import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { Copy, Download, FileIcon } from '@/components/icons/reicon'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { copyImageToClipboard, copyToClipboard } from '@/lib/clipboard'
import {
  downloadLocalFile,
  openLocalFile,
  resolveWorktreeFilePath,
} from '@/lib/local-file'

const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE_PX = 10

/** Read the current window selection as trimmed plain text. */
export function getTrimmedSelectionText(): string {
  if (typeof window === 'undefined') return ''
  return window.getSelection()?.toString().trim() ?? ''
}

/**
 * Suppress the browser/OS default context menu on empty chat-thread chrome
 * (padding, gaps between messages) while leaving message-level custom menus
 * free to handle their own right-clicks.
 */
export function suppressDefaultContextMenu(
  event: React.MouseEvent | MouseEvent
): void {
  event.preventDefault()
}

interface MessageThreadContextMenuProps {
  children: ReactElement
  /**
   * Full message/response text for the "Copy message" / "Copy response" action.
   * Ignored when `onCopyMessage` is provided.
   */
  messageText?: string
  /** Label for the full-message copy action. */
  copyMessageLabel?: string
  /**
   * Custom full-message copy handler (e.g. rich user-prompt clipboard with
   * attachment metadata). Falls back to copying `messageText`.
   */
  onCopyMessage?: () => void | Promise<void>
}

/**
 * Custom right-click menu for session-thread messages.
 * Replaces the unusable browser default (Back / Refresh / Save as / Print)
 * with copy-focused actions.
 */
export function MessageThreadContextMenu({
  children,
  messageText = '',
  copyMessageLabel = 'Copy message',
  onCopyMessage,
}: MessageThreadContextMenuProps) {
  const [selection, setSelection] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [filePath, setFilePath] = useState('')
  const [imageSrc, setImageSrc] = useState('')

  // Runs on contextmenu (right-click, Android long press) and on pointerdown,
  // because Radix opens touch long presses from a pointerdown timer and iOS
  // Safari never fires contextmenu.
  const captureMenuTarget = useCallback((event: React.SyntheticEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const image = target?.closest('img')
    setImageSrc(
      image instanceof HTMLImageElement ? image.currentSrc || image.src : ''
    )
    const link = target?.closest('a[href]')
    setLinkUrl(link instanceof HTMLAnchorElement ? link.href : '')
    const fileCode = target?.closest<HTMLElement>('code[data-file-path]')
    setFilePath(fileCode?.dataset.filePath ?? '')
  }, [])

  // Radix cancels its touch long press on any pointermove, and a finger
  // held on iOS always jitters a little. Open the menu for file paths with
  // our own long press that allows small moves.
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>
    x: number
    y: number
  } | null>(null)
  // The click that ends a long press must not also open the file.
  const longPressFiredRef = useRef(false)

  const cancelLongPress = useCallback(() => {
    if (longPressRef.current) clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      captureMenuTarget(event)
      cancelLongPress()
      longPressFiredRef.current = false
      if (event.pointerType === 'mouse') return
      const target = event.target instanceof Element ? event.target : null
      const fileCode = target?.closest('code[data-file-path]')
      if (!fileCode) return
      const { clientX, clientY } = event
      longPressRef.current = {
        x: clientX,
        y: clientY,
        timer: setTimeout(() => {
          longPressRef.current = null
          longPressFiredRef.current = true
          fileCode.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX,
              clientY,
            })
          )
        }, LONG_PRESS_MS),
      }
    },
    [captureMenuTarget, cancelLongPress]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const press = longPressRef.current
      if (!press) return
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
      if (moved > LONG_PRESS_MOVE_TOLERANCE_PX) cancelLongPress()
    },
    [cancelLongPress]
  )

  const handleClickCapture = useCallback((event: React.MouseEvent) => {
    if (!longPressFiredRef.current) return
    longPressFiredRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  useEffect(() => cancelLongPress, [cancelLongPress])

  const handleOpenChange = useCallback((open: boolean) => {
    // Capture selection when the menu opens — opening the menu can clear
    // the live Selection before the user picks an item.
    if (open) {
      setSelection(getTrimmedSelectionText())
    }
  }, [])

  const handleCopySelection = useCallback(() => {
    if (!selection) return
    void copyToClipboard(selection)
      .then(() => toast.success('Copied to clipboard'))
      .catch(() => toast.error('Failed to copy'))
  }, [selection])

  const handleCopyImage = useCallback(() => {
    if (!imageSrc) return
    void copyImageToClipboard(imageSrc)
      .then(() => toast.success('Image copied to clipboard'))
      .catch(error => toast.error(`Failed to copy image: ${error}`))
  }, [imageSrc])

  const handleCopyUrl = useCallback(() => {
    if (!linkUrl) return
    void copyToClipboard(linkUrl)
      .then(() => toast.success('Copied to clipboard'))
      .catch(() => toast.error('Failed to copy'))
  }, [linkUrl])

  const handleOpenFile = useCallback(() => {
    if (!openLocalFile(filePath)) toast.error('Cannot resolve file path')
  }, [filePath])

  const handleDownloadFile = useCallback(() => {
    const path = resolveWorktreeFilePath(filePath)
    if (!path) {
      toast.error('Cannot resolve file path')
      return
    }
    void downloadLocalFile(path).catch(error => {
      toast.error(`Failed to download file: ${error}`)
    })
  }, [filePath])

  const handleCopyMessage = useCallback(() => {
    if (onCopyMessage) {
      void Promise.resolve(onCopyMessage()).catch(() => {
        toast.error('Failed to copy')
      })
      return
    }
    const text = messageText.trim()
    if (!text) return
    void copyToClipboard(text)
      .then(() => toast.success('Copied to clipboard'))
      .catch(() => toast.error('Failed to copy'))
  }, [messageText, onCopyMessage])

  const canCopyMessage = Boolean(onCopyMessage || messageText.trim())
  const canCopySelection = selection.length > 0

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger
        asChild
        onContextMenu={captureMenuTarget}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onClickCapture={handleClickCapture}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {imageSrc && (
          <ContextMenuItem onSelect={handleCopyImage}>
            <Copy className="h-4 w-4" />
            Copy image
          </ContextMenuItem>
        )}
        {filePath && (
          <>
            <ContextMenuItem onSelect={handleOpenFile}>
              <FileIcon className="h-4 w-4" />
              Open file
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleDownloadFile}>
              <Download className="h-4 w-4" />
              Download file
            </ContextMenuItem>
          </>
        )}
        {linkUrl && (
          <ContextMenuItem onSelect={handleCopyUrl}>
            <Copy className="h-4 w-4" />
            Copy URL
          </ContextMenuItem>
        )}
        {canCopySelection && (
          <ContextMenuItem onSelect={handleCopySelection}>
            <Copy className="h-4 w-4" />
            Copy
          </ContextMenuItem>
        )}
        {canCopyMessage && (
          <ContextMenuItem onSelect={handleCopyMessage}>
            <Copy className="h-4 w-4" />
            {copyMessageLabel}
          </ContextMenuItem>
        )}
        {!imageSrc && !canCopySelection && !canCopyMessage && (
          <ContextMenuItem disabled>No text to copy</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
