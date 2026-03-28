import { getModifierSymbol } from '@/lib/platform'
import {
  GitBranch,
  GitPullRequest,
  Loader2,
  CircleDot,
  Shield,
  ShieldAlert,
  Wand2,
  Eye,
} from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isNewIssue } from '@/services/github'
import type {
  GitHubIssue,
  GitHubPullRequest,
  DependabotAlert,
  RepositoryAdvisory,
} from '@/types/github'
import type { TabId, Tab } from './NewWorktreeModal'

// Re-export TABS for use in SessionTabBar
export { TABS } from './NewWorktreeModal'

export function SessionTabBar({
  activeTab,
  onTabChange,
  tabs,
}: {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  tabs: Tab[]
}) {
  return (
    <div className="flex overflow-x-auto border-b border-border scrollbar-hide">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          tabIndex={-1}
          className={cn(
            'flex-1 px-4 py-2 text-sm font-medium transition-colors',
            'flex items-center justify-center gap-1.5',
            'hover:bg-accent focus:outline-none',
            'border-b-2',
            activeTab === tab.id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground'
          )}
        >
          <tab.icon className="h-4 w-4" />
          <span className="text-xs sm:text-sm">{tab.label}</span>
          <kbd className="hidden sm:inline ml-0.5 text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">
            {getModifierSymbol()}+{tab.key}
          </kbd>
        </button>
      ))}
    </div>
  )
}

export interface IssueItemProps {
  issue: GitHubIssue
  index: number
  isSelected: boolean
  isCreating: boolean
  onMouseEnter: () => void
  onClick: (background: boolean) => void
  onInvestigate: (background: boolean) => void
  onPreview: () => void
  onLabelClick?: (label: string) => void
}

export function IssueItem({
  issue,
  index,
  isSelected,
  isCreating,
  onMouseEnter,
  onClick,
  onInvestigate,
  onPreview,
  onLabelClick,
}: IssueItemProps) {
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
        <CircleDot
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            issue.state === 'OPEN' ? 'text-green-500' : 'text-purple-500'
          )}
        />
      )}
      <button
        onClick={e => onClick(e.metaKey)}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">#{issue.number}</span>
          <span className="text-sm font-medium truncate">{issue.title}</span>
          {isNewIssue(issue.created_at) && (
            <span className="shrink-0 rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-600 border border-green-500/20">
              New
            </span>
          )}
        </div>
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {issue.labels.slice(0, 3).map(label => (
              <span
                key={label.name}
                className={cn(
                  'px-1.5 py-0.5 text-xs rounded-full',
                  onLabelClick &&
                    'cursor-pointer hover:opacity-75 transition-opacity'
                )}
                style={{
                  backgroundColor: `#${label.color}20`,
                  color: `#${label.color}`,
                  border: `1px solid #${label.color}40`,
                }}
                onClick={
                  onLabelClick
                    ? e => {
                        e.stopPropagation()
                        onLabelClick(label.name)
                      }
                    : undefined
                }
              >
                {label.name}
              </span>
            ))}
            {issue.labels.length > 3 && (
              <span className="text-xs text-muted-foreground">
                +{issue.labels.length - 3}
              </span>
            )}
          </div>
        )}
      </button>
      <div className="shrink-0 flex items-center gap-1 self-center">
        {/* Preview button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onPreview()
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:text-foreground hover:bg-muted"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Preview issue ({getModifierSymbol()}O)
          </TooltipContent>
        </Tooltip>
        {/* Investigate button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onInvestigate(e.metaKey || e.ctrlKey)
              }}
              disabled={isCreating}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Wand2 className="h-3 w-3 text-current dark:text-yellow-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Create worktree and investigate issue ({getModifierSymbol()}M)
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export interface PRItemProps {
  pr: GitHubPullRequest
  index: number
  isSelected: boolean
  isCreating: boolean
  onMouseEnter: () => void
  onClick: (background: boolean) => void
  onInvestigate: (background: boolean) => void
  onPreview: () => void
  onLabelClick?: (label: string) => void
}

export function PRItem({
  pr,
  index,
  isSelected,
  isCreating,
  onMouseEnter,
  onClick,
  onInvestigate,
  onPreview,
  onLabelClick,
}: PRItemProps) {
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
        <GitPullRequest
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            pr.state === 'OPEN'
              ? 'text-green-500'
              : pr.state === 'MERGED'
                ? 'text-purple-500'
                : 'text-red-500'
          )}
        />
      )}
      <button
        onClick={e => onClick(e.metaKey)}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">#{pr.number}</span>
          <span className="text-sm font-medium truncate">{pr.title}</span>
          {pr.isDraft && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              Draft
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground truncate">
            {pr.headRefName} → {pr.baseRefName}
          </span>
        </div>
        {pr.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {pr.labels.slice(0, 3).map(label => (
              <span
                key={label.name}
                className={cn(
                  'px-1.5 py-0.5 text-xs rounded-full',
                  onLabelClick &&
                    'cursor-pointer hover:opacity-75 transition-opacity'
                )}
                style={{
                  backgroundColor: `#${label.color}20`,
                  color: `#${label.color}`,
                  border: `1px solid #${label.color}40`,
                }}
                onClick={
                  onLabelClick
                    ? e => {
                        e.stopPropagation()
                        onLabelClick(label.name)
                      }
                    : undefined
                }
              >
                {label.name}
              </span>
            ))}
            {pr.labels.length > 3 && (
              <span className="text-xs text-muted-foreground">
                +{pr.labels.length - 3}
              </span>
            )}
          </div>
        )}
      </button>
      <div className="shrink-0 flex items-center gap-1 self-center">
        {/* Preview button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onPreview()
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:text-foreground hover:bg-muted"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Preview PR ({getModifierSymbol()}O)</TooltipContent>
        </Tooltip>
        {/* Investigate button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onInvestigate(e.metaKey || e.ctrlKey)
              }}
              disabled={isCreating}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Wand2 className="h-3 w-3 text-current dark:text-yellow-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Create worktree and investigate PR ({getModifierSymbol()}M)
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export interface BranchItemProps {
  branch: string
  index: number
  isSelected: boolean
  isCreating: boolean
  onMouseEnter: () => void
  onClick: (background: boolean) => void
}

export function BranchItem({
  branch,
  index,
  isSelected,
  isCreating,
  onMouseEnter,
  onClick,
}: BranchItemProps) {
  return (
    <button
      data-item-index={index}
      onMouseEnter={onMouseEnter}
      onClick={e => onClick(e.metaKey)}
      disabled={isCreating}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 sm:py-2 text-left transition-colors',
        'hover:bg-accent',
        isSelected && 'bg-accent',
        isCreating && 'opacity-50',
        'focus:outline-none disabled:cursor-not-allowed'
      )}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <GitBranch className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      )}
      <span className="text-sm truncate">{branch}</span>
    </button>
  )
}

// =============================================================================
// Security Alert Item
// =============================================================================

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/20',
  high: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
  medium: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
  low: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
}

export interface SecurityAlertItemProps {
  alert: DependabotAlert
  index: number
  isSelected: boolean
  isCreating: boolean
  onMouseEnter: () => void
  onClick: (background: boolean) => void
  onInvestigate: (background: boolean) => void
  onPreview: () => void
}

export function SecurityAlertItem({
  alert,
  index,
  isSelected,
  isCreating,
  onMouseEnter,
  onClick,
  onInvestigate,
  onPreview,
}: SecurityAlertItemProps) {
  const severityClass =
    SEVERITY_COLORS[alert.severity.toLowerCase()] ??
    'bg-muted text-muted-foreground border-border'

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
        <Shield
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            alert.state === 'open' ? 'text-orange-500' : 'text-muted-foreground'
          )}
        />
      )}
      <button
        onClick={e => onClick(e.metaKey)}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium border',
              severityClass
            )}
          >
            {alert.severity}
          </span>
          <span className="text-xs text-muted-foreground">#{alert.number}</span>
          <span className="text-sm font-medium truncate">
            {alert.packageName}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
          <span className="text-xs text-muted-foreground truncate">
            {alert.summary}
          </span>
          <span className="text-xs text-muted-foreground/60 shrink-0">
            {alert.cveId ?? alert.ghsaId}
          </span>
        </div>
      </button>
      <div className="shrink-0 flex items-center gap-1 self-center">
        {/* Preview button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onPreview()
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:text-foreground hover:bg-muted"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Preview alert ({getModifierSymbol()}O)
          </TooltipContent>
        </Tooltip>
        {/* Investigate button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onInvestigate(e.metaKey || e.ctrlKey)
              }}
              disabled={isCreating}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Wand2 className="h-3 w-3 text-current dark:text-yellow-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Create worktree and investigate alert ({getModifierSymbol()}M)
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// =============================================================================
// Advisory Item
// =============================================================================

export interface AdvisoryItemProps {
  advisory: RepositoryAdvisory
  index: number
  isSelected: boolean
  isCreating: boolean
  onMouseEnter: () => void
  onClick: (background: boolean) => void
  onInvestigate: (background: boolean) => void
  onPreview: () => void
}

export function AdvisoryItem({
  advisory,
  index,
  isSelected,
  isCreating,
  onMouseEnter,
  onClick,
  onInvestigate,
  onPreview,
}: AdvisoryItemProps) {
  const severityClass =
    SEVERITY_COLORS[advisory.severity.toLowerCase()] ??
    'bg-muted text-muted-foreground border-border'

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
        <ShieldAlert
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            advisory.state === 'published'
              ? 'text-orange-500'
              : 'text-muted-foreground'
          )}
        />
      )}
      <button
        onClick={e => onClick(e.metaKey)}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium border',
              severityClass
            )}
          >
            {advisory.severity}
          </span>
          <span className="text-sm font-medium truncate">
            {advisory.summary}
          </span>
          {advisory.vulnerabilities.length > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground border border-border">
              {advisory.vulnerabilities.length} vuln
              {advisory.vulnerabilities.length !== 1 && 's'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xs text-muted-foreground/60 shrink-0">
            {advisory.cveId ?? advisory.ghsaId}
          </span>
        </div>
      </button>
      <div className="shrink-0 flex items-center gap-1 self-center">
        {/* Preview button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onPreview()
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:text-foreground hover:bg-muted"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Preview advisory ({getModifierSymbol()}O)
          </TooltipContent>
        </Tooltip>
        {/* Investigate button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={e => {
                e.stopPropagation()
                onInvestigate(e.metaKey || e.ctrlKey)
              }}
              disabled={isCreating}
              className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Wand2 className="h-3 w-3 text-current dark:text-yellow-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Create worktree and investigate advisory ({getModifierSymbol()}M)
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
