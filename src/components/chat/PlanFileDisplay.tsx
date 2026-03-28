import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileText, AlertCircle } from 'lucide-react'
import { readPlanFile } from '@/services/chat'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { getFilename } from '@/lib/path-utils'
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible'

interface PlanDisplayBaseProps {
  className?: string
  /** If true, plan starts collapsed (used when plan is already approved) */
  defaultCollapsed?: boolean
}

interface PlanDisplayFileProps extends PlanDisplayBaseProps {
  /** File path to load plan content from */
  filePath: string
  content?: never
}

interface PlanDisplayInlineProps extends PlanDisplayBaseProps {
  /** Inline plan content (takes precedence over filePath) */
  content: string
  filePath?: never
}

type PlanDisplayProps = PlanDisplayFileProps | PlanDisplayInlineProps

/**
 * Display plan content in a collapsible section.
 * Uses conditional rendering (no CSS animation) to avoid scroll timing races
 * when plans collapse programmatically (approval or follow-up message).
 */
export function PlanDisplay({
  content: inlineContent,
  filePath,
  className,
  defaultCollapsed = false,
}: PlanDisplayProps) {
  const [isOpen, setIsOpen] = useState(!defaultCollapsed)

  // Render-time sync: when defaultCollapsed transitions to true, close immediately
  // in the same render frame (no useEffect delay). React re-renders before commit.
  // See: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [prevDefaultCollapsed, setPrevDefaultCollapsed] =
    useState(defaultCollapsed)
  if (defaultCollapsed && !prevDefaultCollapsed) {
    setPrevDefaultCollapsed(true)
    setIsOpen(false)
  }

  // Extract filename from path for display (only for file-based plans)
  const filename = filePath ? getFilename(filePath) : null

  // Only fetch if we have a filePath and no inline content
  const { data: fetchedContent, isLoading } = useQuery({
    queryKey: ['planFile', filePath],
    queryFn: () => {
      // Query is disabled when !filePath, so this is always defined here
      if (!filePath) throw new Error('filePath is required')
      return readPlanFile(filePath)
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 1,
    enabled: !!filePath && !inlineContent,
  })

  // Use inline content if provided, otherwise use fetched content
  const content = inlineContent ?? fetchedContent

  if (!inlineContent && isLoading) {
    return (
      <div
        className={cn(
          'rounded-md border border-border/50 bg-muted/30 px-3 py-2',
          className
        )}
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="h-4 w-4" />
          <span>Loading plan...</span>
        </div>
      </div>
    )
  }

  if (!content) {
    return (
      <div
        className={cn(
          'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2',
          className
        )}
      >
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          <span>Failed to load plan file</span>
        </div>
      </div>
    )
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        'rounded-md border border-border/50 bg-muted/30',
        className
      )}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 cursor-pointer">
        <FileText className="h-4 w-4 shrink-0" />
        <span className="font-medium">Plan</span>
        {filename && (
          <code className="truncate rounded bg-muted/50 px-1.5 py-0.5 text-xs">
            {filename}
          </code>
        )}
        <ChevronRight
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200',
            isOpen && 'rotate-90'
          )}
        />
      </CollapsibleTrigger>
      {isOpen && (
        <div className="border-t border-border/50 px-3 py-3">
          <div>
            <Markdown className="text-sm">{content}</Markdown>
          </div>
        </div>
      )}
    </Collapsible>
  )
}

// Re-export with old name for backwards compatibility
export { PlanDisplay as PlanFileDisplay }
