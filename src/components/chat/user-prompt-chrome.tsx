import { toast } from 'sonner'
import { Copy } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { copyHtmlToClipboard, copyToClipboard } from '@/lib/clipboard'
import { getFilename, normalizePath } from '@/lib/path-utils'
import type { ChatMessage } from '@/types/chat'
import {
  buildPromptAttachmentMetadata,
  encodePromptAttachmentMetadata,
  stripAllMarkers,
} from './message-content-utils'

/** Chat user prompt: a subtle bordered card. */
export const USER_CARD_BUBBLE_CLASS =
  'min-w-0 break-words [overflow-wrap:anywhere] rounded-lg border border-border/20 bg-muted/20 px-3 py-2 text-foreground'

// Per-message chrome (settings, copy, restore, duration) appears on hover or
// keyboard focus. Touch devices have no hover, so it stays visible there.
export const USER_HOVER_REVEAL =
  'transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100'
// Touch devices have no hover: details stay hidden until the prompt is tapped
export const USER_TAP_HIDDEN = '[@media(pointer:coarse)]:hidden'

export function CopyIconButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          className="text-muted-foreground/40 hover:text-muted-foreground"
        >
          <Copy className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Copies a prompt as plain text plus HTML with Jean attachment metadata, so
 * pasting it back into the chat input restores its attachments.
 */
export async function copyPromptToClipboard(content: string): Promise<void> {
  const cleanText = stripAllMarkers(content)
  const metadata = buildPromptAttachmentMetadata(content, path => {
    const parts = normalizePath(path).split('/')
    const skillsIdx = parts.findIndex(p => p === 'skills')
    return skillsIdx >= 0 && parts[skillsIdx + 1]
      ? (parts[skillsIdx + 1] ?? getFilename(path))
      : getFilename(path)
  })
  const encodedMetadata = encodePromptAttachmentMetadata(metadata)
  const escapedCleanText = cleanText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const htmlContent = `<span data-jean-prompt="${encodedMetadata}">${escapedCleanText}</span>`

  try {
    await copyHtmlToClipboard(htmlContent, cleanText, cleanText)
  } catch {
    // If rich clipboard writes are unavailable, copy clean plain text so
    // external paste targets never receive Jean metadata comments.
    await copyToClipboard(cleanText)
  }
  toast.success('Prompt copied')
}

/** The user prompt that started the turn containing `index`. */
export function findTurnPrompt(
  messages: readonly ChatMessage[],
  index: number
): ChatMessage | undefined {
  for (let i = Math.min(index, messages.length) - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return undefined
}
