import { memo, useCallback, useState } from 'react'
import { Brain, ChevronRight } from '@/components/icons/reicon'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/ui/markdown'
import type { ThinkingLevel } from '@/types/chat'
import { TOOL_CALL_ROW_CLASS } from './ToolCallInline'

interface ThinkingBlockProps {
  /** The thinking content to display */
  thinking: string
  /** Whether this is during streaming (affects animation) */
  isStreaming?: boolean
  /** The current thinking level (ultrathink doesn't animate) */
  thinkingLevel?: ThinkingLevel
}

/**
 * Collapsible thinking block that shows Claude's extended thinking
 * Memoized to prevent re-renders when parent state changes
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  isStreaming = false,
}: ThinkingBlockProps) {
  // Only mount (and parse) the Markdown while expanded. Native <details>
  // keeps collapsed children mounted, which re-parses the full thinking text
  // on every streaming flush.
  const [isOpen, setIsOpen] = useState(false)
  const handleToggle = useCallback(
    (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      setIsOpen(e.currentTarget.open)
    },
    []
  )

  return (
    <details
      className="group border border-border/50 rounded-md bg-muted/30"
      onToggle={handleToggle}
    >
      <summary
        className={cn(
          TOOL_CALL_ROW_CLASS,
          'cursor-pointer hover:text-foreground transition-colors'
        )}
      >
        <Brain className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground')} />
        <span>Thinking...</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90" />
      </summary>
      <div className="border-t border-border/50 px-3 py-2">
        <div className="pl-4 border-l-2 border-border text-sm text-muted-foreground">
          {isOpen && (
            <Markdown streaming={isStreaming} variant="tool-call">
              {thinking}
            </Markdown>
          )}
        </div>
      </div>
    </details>
  )
})
