import { useEffect, useRef, type RefObject } from 'react'

/**
 * Blank space after the chat content, so the latest prompt can scroll to the
 * top of the viewport. Following the chat tail then shows a new prompt at the
 * top, with its reply growing below it.
 *
 * Render it as the next sibling of the message content, inside the padded
 * wrapper. Prompts are elements with `data-user-prompt` (and
 * `data-message-anchor-id`). With one prompt or fewer there is no history
 * above, so the spacer stays empty.
 *
 * When a session opens, its last prompt also gets the space, so the session
 * shows the last prompt at the top with its reply below it, not the history.
 *
 * `bottomInset` is the wrapper's bottom padding as a CSS length. CSS subtracts
 * it from the height, so when the composer grows or shrinks (queued prompts,
 * subagents, multi-line input), the padding and the spacer change in the same
 * layout and the prompt stays at the top.
 */
export function PromptTopSpacer({
  viewportRef,
  sessionId,
  bottomInset,
}: {
  viewportRef: RefObject<HTMLElement | null>
  sessionId: string | null | undefined
  bottomInset: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const spacer = ref.current
    const viewport = viewportRef.current
    const content = spacer?.previousElementSibling
    const wrapper = spacer?.parentElement
    if (!spacer || !viewport || !content || !wrapper) return

    // Last height set. Browsers may normalize style.height, so do not compare it.
    let current = ''

    const update = () => {
      const prompts =
        content.querySelectorAll<HTMLElement>('[data-user-prompt]')
      const last = prompts[prompts.length - 1]
      const prompt = prompts.length > 1 ? last : null
      let next = '0px'
      if (prompt) {
        const available =
          viewport.clientHeight -
          parseFloat(getComputedStyle(wrapper).paddingTop)
        const tail =
          spacer.getBoundingClientRect().top -
          prompt.getBoundingClientRect().top
        next = `max(0px, ${Math.floor(available - tail)}px - ${bottomInset})`
      }
      if (next === current) return
      current = next
      const wasAtBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2
      spacer.style.height = next
      // Re-pin in this frame. The scroll manager re-pins one frame later,
      // which paints the old position first and flickers on session open.
      if (wasAtBottom) viewport.scrollTop = viewport.scrollHeight
    }

    // The spacer is not observed, so setting its height cannot loop
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [viewportRef, sessionId, bottomInset])

  return <div ref={ref} aria-hidden="true" />
}
