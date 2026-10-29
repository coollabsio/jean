import type { ReactNode } from 'react'
import { Markdown } from '@/components/ui/markdown'

/**
 * Borderless pill bubble shared by agent chat replies and prompts.
 * Code uses bg-muted too, so it gets the page background to stand out.
 */
export const PILL_BUBBLE_CLASS =
  'min-w-0 break-words [overflow-wrap:anywhere] rounded-[22px] bg-muted/60 px-4 py-2.5 text-foreground [&_pre]:bg-background [&_:not(pre)>code]:bg-background'

/** Agent chat user prompt: a pill bubble in the agent's accent color. */
export const USER_PILL_BUBBLE_CLASS = [
  PILL_BUBBLE_CLASS,
  '[--bubble-bg:var(--agent-accent,var(--muted))] bg-(--bubble-bg)',
  // Agent-colored bubbles are strong shades: use white text
  '[--bubble-fg:var(--agent-accent-fg,var(--foreground))] text-(--bubble-fg) [&_a]:text-inherit',
  // Attachments: the bubble color, a bit darker
  '[&_[data-attachments]>*]:border-transparent [&_[data-attachments]>*]:bg-[color-mix(in_oklab,var(--bubble-bg)_80%,black)]',
].join(' ')

/** Chat user prompt: a subtle bordered card. */
export const USER_CARD_BUBBLE_CLASS =
  'min-w-0 break-words [overflow-wrap:anywhere] rounded-lg border border-border/20 bg-muted/20 px-3 py-2 text-foreground'

/** Agent chat reply: a pill bubble, aligned left. */
export function ReplyBubble({ children }: { children: ReactNode }) {
  return (
    <div className={`w-fit max-w-full sm:max-w-[85%] ${PILL_BUBBLE_CLASS}`}>
      {children}
    </div>
  )
}

/** Agent chat reply parts, each in its own bubble so each reads as a separate answer. */
export function ReplyBubbles({
  parts,
  messageId,
  sessionId,
  streaming = false,
}: {
  parts: string[]
  messageId?: string
  sessionId?: string | null
  streaming?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {parts.map((part, index) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- streamed parts only append; Markdown state keys off the positional messageId
        <ReplyBubble key={index}>
          <Markdown
            streaming={streaming && index === parts.length - 1}
            // The first part keeps the message id, so saved table and
            // checklist state of single-part replies still matches
            messageId={
              messageId && index > 0 ? `${messageId}:part${index}` : messageId
            }
            sessionId={sessionId ?? undefined}
          >
            {part}
          </Markdown>
        </ReplyBubble>
      ))}
    </div>
  )
}
