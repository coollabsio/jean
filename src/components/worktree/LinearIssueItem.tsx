import { Loader2, Wand2, Eye } from 'lucide-react'
import { getModifierSymbol } from '@/lib/platform'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LinearIssue } from '@/types/linear'

export interface LinearIssueItemProps {
  issue: LinearIssue
  index: number
  isSelected: boolean
  isCreating: boolean
  onMouseEnter: () => void
  onClick: (background: boolean) => void
  onInvestigate: (background: boolean) => void
  onPreview?: () => void
}

/** Check if issue was created in the last 7 days */
function isNewIssue(createdAt: string): boolean {
  const created = new Date(createdAt)
  const now = new Date()
  const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays <= 7
}

export function LinearIssueItem({
  issue,
  index,
  isSelected,
  isCreating,
  onMouseEnter,
  onClick,
  onInvestigate,
  onPreview,
}: LinearIssueItemProps) {
  return (
    <div
      data-item-index={index}
      onMouseEnter={onMouseEnter}
      className={cn(
        'group w-full flex items-start gap-3 px-3 py-2.5 sm:py-2 text-left transition-colors',
        'hover:bg-accent',
        isSelected && 'bg-accent',
        isCreating && 'opacity-50'
      )}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <div
          className="h-4 w-4 mt-0.5 flex-shrink-0 rounded-full border-2"
          style={{ borderColor: issue.state.color }}
          title={issue.state.name}
        />
      )}
      <button
        onClick={e => onClick(e.metaKey)}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono">
            {issue.identifier}
          </span>
          <span className="text-sm font-medium truncate">{issue.title}</span>
          {isNewIssue(issue.createdAt) && (
            <span className="shrink-0 rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-600 border border-green-500/20">
              New
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 mt-1">
          {issue.priority > 0 && (
            <span className="px-1.5 py-0.5 text-xs rounded-full bg-muted text-muted-foreground">
              {issue.priorityLabel}
            </span>
          )}
          {issue.labels.slice(0, 3).map(label => (
            <span
              key={label.name}
              className="px-1.5 py-0.5 text-xs rounded-full"
              style={{
                backgroundColor: `${label.color}20`,
                color: label.color,
                border: `1px solid ${label.color}40`,
              }}
            >
              {label.name}
            </span>
          ))}
          {issue.labels.length > 3 && (
            <span className="text-xs text-muted-foreground">
              +{issue.labels.length - 3}
            </span>
          )}
          {issue.assignee && (
            <span className="text-xs text-muted-foreground ml-1">
              {issue.assignee.displayName}
            </span>
          )}
        </div>
      </button>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onInvestigate(e.metaKey)
              }}
              disabled={isCreating}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isCreating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Wand2 className="h-3 w-3 text-current dark:text-yellow-400" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Investigate ({getModifierSymbol()}+M)</TooltipContent>
        </Tooltip>
        {onPreview && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    onPreview()
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Eye className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Preview ({getModifierSymbol()}+O)</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  )
}
