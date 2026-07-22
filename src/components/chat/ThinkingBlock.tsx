import { memo } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
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
  return (
    <details className="group min-w-0">
      <summary
        className={cn(
          TOOL_CALL_ROW_CLASS,
          'cursor-pointer hover:text-foreground transition-colors'
        )}
      >
        <Brain className={cn('h-3.5 w-3.5 shrink-0 text-purple-500')} />
        <span>Thinking...</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90" />
      </summary>
      <div className="ml-5 border-l border-purple-500/30 pl-3 py-1.5">
        <div className="text-sm text-muted-foreground">
          <Markdown streaming={isStreaming} variant="tool-call">
            {thinking}
          </Markdown>
        </div>
      </div>
    </details>
  )
})
