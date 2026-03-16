import { memo } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/ui/markdown'
import type { ThinkingLevel } from '@/types/chat'

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
    <details className="group border border-border/50 rounded-md bg-muted/30">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <Brain className={cn('h-3.5 w-3.5 text-purple-500')} />
        <span>Thinking...</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90" />
      </summary>
      <div className="border-t border-border/50 px-3 py-2">
        <div className="pl-4 border-l-2 border-purple-500/30 text-sm text-muted-foreground">
          <Markdown streaming={isStreaming}>{thinking}</Markdown>
        </div>
      </div>
    </details>
  )
})
