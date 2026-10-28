import { useEffect, useRef, type RefObject } from 'react'

/**
 * Blank space after the chat content, so the latest prompt can scroll to the
 * top of the viewport. Following the chat tail then shows a new prompt at the
 * top, with its reply growing below it.
 *
 * Render it as the next sibling of the message content, inside the padded
 * wrapper. Prompts are elements with `data-user-prompt`. With one prompt or
 * fewer there is no history above, so the spacer stays empty.
 */
export function PromptTopSpacer({
  viewportRef,
}: {
  viewportRef: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const spacer = ref.current
    const viewport = viewportRef.current
    const content = spacer?.previousElementSibling
    const wrapper = spacer?.parentElement
    if (!spacer || !viewport || !content || !wrapper) return

    const update = () => {
      const prompts = content.querySelectorAll('[data-user-prompt]')
      const prompt = prompts.length > 1 ? prompts[prompts.length - 1] : null
      let height = 0
      if (prompt) {
        const style = getComputedStyle(wrapper)
        const available =
          viewport.clientHeight -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom)
        const tail =
          spacer.getBoundingClientRect().top -
          prompt.getBoundingClientRect().top
        height = Math.max(0, Math.floor(available - tail))
      }
      const next = `${height}px`
      if (spacer.style.height === next) return
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
  }, [viewportRef])

  return <div ref={ref} aria-hidden="true" />
}
