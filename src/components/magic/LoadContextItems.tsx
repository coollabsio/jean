import {
  CircleDot,
  Eye,
  FolderOpen,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  Shield,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { getModifierSymbol } from '@/lib/platform'
import { cn } from '@/lib/utils'
import type {
  GitHubIssue,
  GitHubPullRequest,
  DependabotAlert,
  RepositoryAdvisory,
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
  AttachedSavedContext,
} from '@/types/github'
import type { SavedContext, AllSessionsEntry, Session } from '@/types/chat'

/** Session with worktree context for the click handler */
export interface SessionWithContext {
  session: Session
  worktreeId: string
  worktreePath: string
  projectName: string
}

/** Format file size to human-readable string */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// =============================================================================
// Loaded Issue Item
// =============================================================================

interface LoadedIssueItemProps {
  context: LoadedIssueContext
  isLoading: boolean
  isRemoving: boolean
  onRefresh: () => void
  onRemove: () => void
  onView: () => void
}

export function LoadedIssueItem({
  context,
  isLoading,
  isRemoving,
  onRefresh,
  onRemove,
  onView,
}: LoadedIssueItemProps) {
  const isDisabled = isLoading || isRemoving

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 hover:bg-accent/50 transition-colors',
        isDisabled && 'opacity-50'
      )}
    >
      <CircleDot className="h-4 w-4 text-green-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            #{context.number}
          </span>
          <span className="text-sm truncate">{context.title}</span>
          {context.commentCount > 0 && (
            <span className="text-xs text-muted-foreground">
              ({context.commentCount} comments)
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onView}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>View context</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRefresh}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Refresh issue</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRemove}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-destructive/10 focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isRemoving ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from context</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// =============================================================================
// Loaded PR Item
// =============================================================================

interface LoadedPRItemProps {
  context: LoadedPullRequestContext
  isLoading: boolean
  isRemoving: boolean
  onRefresh: () => void
  onRemove: () => void
  onView: () => void
}

export function LoadedPRItem({
  context,
  isLoading,
  isRemoving,
  onRefresh,
  onRemove,
  onView,
}: LoadedPRItemProps) {
  const isDisabled = isLoading || isRemoving

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 hover:bg-accent/50 transition-colors',
        isDisabled && 'opacity-50'
      )}
    >
      <GitPullRequest className="h-4 w-4 text-green-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            #{context.number}
          </span>
          <span className="text-sm truncate">{context.title}</span>
          {(context.commentCount > 0 || context.reviewCount > 0) && (
            <span className="text-xs text-muted-foreground">
              ({context.commentCount} comments, {context.reviewCount} reviews)
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onView}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>View context</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRefresh}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Refresh PR</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRemove}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-destructive/10 focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isRemoving ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from context</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// =============================================================================
// Severity Badge (shared)
// =============================================================================

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/20',
  high: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
  medium: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
  low: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
}

function SeverityBadge({ severity }: { severity: string }) {
  const colorClasses = SEVERITY_COLORS[severity.toLowerCase()] ?? 'bg-muted text-muted-foreground border-border'
  return (
    <span
      className={cn(
        'px-1.5 py-0.5 text-[10px] rounded-full border capitalize flex-shrink-0',
        colorClasses
      )}
    >
      {severity}
    </span>
  )
}

// =============================================================================
// Loaded Security Item
// =============================================================================

interface LoadedSecurityItemProps {
  context: LoadedSecurityAlertContext
  isLoading: boolean
  isRemoving: boolean
  onRefresh: () => void
  onRemove: () => void
  onView: () => void
}

export function LoadedSecurityItem({
  context,
  isLoading,
  isRemoving,
  onRefresh,
  onRemove,
  onView,
}: LoadedSecurityItemProps) {
  const isDisabled = isLoading || isRemoving

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 hover:bg-accent/50 transition-colors',
        isDisabled && 'opacity-50'
      )}
    >
      <Shield className="h-4 w-4 text-orange-500 flex-shrink-0" />
      <SeverityBadge severity={context.severity} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {context.packageName}
          </span>
          <span className="text-xs text-muted-foreground truncate">
            {context.summary}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onView}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>View context</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRefresh}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Refresh alert</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRemove}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-destructive/10 focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isRemoving ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from context</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// =============================================================================
// Security Alert Item (search result)
// =============================================================================

interface SecurityAlertItemProps {
  alert: DependabotAlert
  index: number
  isSelected: boolean
  isLoading: boolean
  onMouseEnter: () => void
  onClick: () => void
  onPreview: () => void
}

export function SecurityAlertItem({
  alert,
  index,
  isSelected,
  isLoading,
  onMouseEnter,
  onClick,
  onPreview,
}: SecurityAlertItemProps) {
  return (
    <div
      data-load-item-index={index}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
        'hover:bg-accent',
        isSelected && 'bg-accent',
        isLoading && 'opacity-50'
      )}
    >
      <button
        onClick={onClick}
        disabled={isLoading}
        className="flex items-start gap-3 flex-1 min-w-0 focus:outline-none"
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
        ) : (
          <Shield
            className={cn(
              'h-4 w-4 mt-0.5 flex-shrink-0',
              alert.state === 'open' ? 'text-orange-500' : 'text-muted-foreground'
            )}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <SeverityBadge severity={alert.severity} />
            <span className="text-xs text-muted-foreground shrink-0">
              #{alert.number}
            </span>
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
        </div>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={e => {
              e.stopPropagation()
              onPreview()
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-colors mt-0.5 flex-shrink-0"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Preview alert ({getModifierSymbol()}O)
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

// =============================================================================
// Loaded Advisory Item
// =============================================================================

interface LoadedAdvisoryItemProps {
  context: LoadedAdvisoryContext
  isLoading: boolean
  isRemoving: boolean
  onRefresh: () => void
  onRemove: () => void
  onView: () => void
}

export function LoadedAdvisoryItem({
  context,
  isLoading,
  isRemoving,
  onRefresh,
  onRemove,
  onView,
}: LoadedAdvisoryItemProps) {
  const isDisabled = isLoading || isRemoving

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 hover:bg-accent/50 transition-colors',
        isDisabled && 'opacity-50'
      )}
    >
      <ShieldAlert className="h-4 w-4 text-orange-500 flex-shrink-0" />
      <SeverityBadge severity={context.severity} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {context.ghsaId}
          </span>
          <span className="text-xs text-muted-foreground truncate">
            {context.summary}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onView}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>View context</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRefresh}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Refresh advisory</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRemove}
              disabled={isDisabled}
              className={cn(
                'p-1 rounded hover:bg-destructive/10 focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isRemoving ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from context</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// =============================================================================
// Advisory Item (search result)
// =============================================================================

interface AdvisoryItemProps {
  advisory: RepositoryAdvisory
  index: number
  isSelected: boolean
  isLoading: boolean
  onMouseEnter: () => void
  onClick: () => void
  onPreview: () => void
}

export function AdvisoryItem({
  advisory,
  index,
  isSelected,
  isLoading,
  onMouseEnter,
  onClick,
  onPreview,
}: AdvisoryItemProps) {
  const vulnCount = advisory.vulnerabilities.length
  return (
    <div
      data-load-item-index={index}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
        'hover:bg-accent',
        isSelected && 'bg-accent',
        isLoading && 'opacity-50'
      )}
    >
      <button
        onClick={onClick}
        disabled={isLoading}
        className="flex items-start gap-3 flex-1 min-w-0 focus:outline-none"
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
        ) : (
          <ShieldAlert
            className={cn(
              'h-4 w-4 mt-0.5 flex-shrink-0',
              advisory.state === 'published' ? 'text-orange-500' : 'text-muted-foreground'
            )}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <SeverityBadge severity={advisory.severity} />
            <span className="text-sm font-medium truncate">
              {advisory.summary}
            </span>
            {vulnCount > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
                {vulnCount} {vulnCount === 1 ? 'pkg' : 'pkgs'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-muted-foreground/60 shrink-0">
              {advisory.cveId ?? advisory.ghsaId}
            </span>
          </div>
        </div>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={e => {
              e.stopPropagation()
              onPreview()
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-colors mt-0.5 flex-shrink-0"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Preview advisory ({getModifierSymbol()}O)
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

// =============================================================================
// Issue Item (search result)
// =============================================================================

interface IssueItemProps {
  issue: GitHubIssue
  index: number
  isSelected: boolean
  isLoading: boolean
  onMouseEnter: () => void
  onClick: () => void
  onPreview: () => void
}

export function IssueItem({
  issue,
  index,
  isSelected,
  isLoading,
  onMouseEnter,
  onClick,
  onPreview,
}: IssueItemProps) {
  return (
    <div
      data-load-item-index={index}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
        'hover:bg-accent',
        isSelected && 'bg-accent',
        isLoading && 'opacity-50'
      )}
    >
      <button
        onClick={onClick}
        disabled={isLoading}
        className="flex items-start gap-3 flex-1 min-w-0 focus:outline-none"
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
        ) : (
          <CircleDot
            className={cn(
              'h-4 w-4 mt-0.5 flex-shrink-0',
              issue.state === 'OPEN' ? 'text-green-500' : 'text-purple-500'
            )}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              #{issue.number}
            </span>
            <span className="text-sm font-medium truncate">{issue.title}</span>
          </div>
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {issue.labels.slice(0, 3).map(label => (
                <span
                  key={label.name}
                  className="px-1.5 py-0.5 text-xs rounded-full"
                  style={{
                    backgroundColor: `#${label.color}20`,
                    color: `#${label.color}`,
                    border: `1px solid #${label.color}40`,
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
            </div>
          )}
        </div>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={e => {
              e.stopPropagation()
              onPreview()
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-colors mt-0.5 flex-shrink-0"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Preview issue ({getModifierSymbol()}O)
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

// =============================================================================
// PR Item (search result)
// =============================================================================

interface PRItemProps {
  pr: GitHubPullRequest
  index: number
  isSelected: boolean
  isLoading: boolean
  onMouseEnter: () => void
  onClick: () => void
  onPreview: () => void
}

export function PRItem({
  pr,
  index,
  isSelected,
  isLoading,
  onMouseEnter,
  onClick,
  onPreview,
}: PRItemProps) {
  return (
    <div
      data-load-item-index={index}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
        'hover:bg-accent',
        isSelected && 'bg-accent',
        isLoading && 'opacity-50'
      )}
    >
      <button
        onClick={onClick}
        disabled={isLoading}
        className="flex items-start gap-3 flex-1 min-w-0 focus:outline-none"
      >
        {isLoading ? (
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
        <div className="flex-1 min-w-0">
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
                  className="px-1.5 py-0.5 text-xs rounded-full"
                  style={{
                    backgroundColor: `#${label.color}20`,
                    color: `#${label.color}`,
                    border: `1px solid #${label.color}40`,
                  }}
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
        </div>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={e => {
              e.stopPropagation()
              onPreview()
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-colors mt-0.5 flex-shrink-0"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Preview PR ({getModifierSymbol()}O)</TooltipContent>
      </Tooltip>
    </div>
  )
}

// =============================================================================
// Context Item (available contexts list)
// =============================================================================

interface ContextItemProps {
  context: SavedContext
  index: number
  isSelected: boolean
  isLoading: boolean
  isEditing: boolean
  editValue: string
  setEditValue: (value: string) => void
  editInputRef: React.RefObject<HTMLInputElement | null>
  onMouseEnter: () => void
  onClick: () => void
  onView: (e: React.MouseEvent) => void
  onStartEdit: (e: React.MouseEvent) => void
  onRenameSubmit: () => void
  onRenameKeyDown: (e: React.KeyboardEvent) => void
  onDelete: (e: React.MouseEvent) => void
}

export function ContextItem({
  context,
  index,
  isSelected,
  isLoading,
  isEditing,
  editValue,
  setEditValue,
  editInputRef,
  onMouseEnter,
  onClick,
  onView,
  onStartEdit,
  onRenameSubmit,
  onRenameKeyDown,
  onDelete,
}: ContextItemProps) {
  if (isEditing) {
    return (
      <div
        data-load-item-index={index}
        className="w-full flex items-start gap-3 px-3 py-2 bg-accent"
      >
        <FolderOpen className="h-4 w-4 mt-0.5 text-blue-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <input
            ref={editInputRef}
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={onRenameKeyDown}
            className="w-full text-sm font-medium bg-transparent border-b border-primary outline-none"
          />
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground truncate">
              {context.project_name}
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <button
      data-load-item-index={index}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      disabled={isLoading}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors group',
        'hover:bg-accent focus:outline-none',
        isSelected && 'bg-accent',
        isLoading && 'opacity-50 cursor-not-allowed'
      )}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <FolderOpen className="h-4 w-4 mt-0.5 text-blue-500 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {context.name || context.slug || 'Untitled'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xs text-muted-foreground font-medium truncate">
            {context.project_name}
          </span>
          <span className="text-xs text-muted-foreground/50">·</span>
          <span className="text-xs text-muted-foreground">
            {formatSize(context.size)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onView}
              className="p-1 rounded hover:bg-muted focus:outline-none"
            >
              <Eye className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Preview</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onStartEdit}
              className="p-1 rounded hover:bg-muted focus:outline-none"
            >
              <Pencil className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Rename</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onDelete}
              className="p-1 rounded hover:bg-destructive/10 focus:outline-none"
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </button>
  )
}

// =============================================================================
// Attached Context Item
// =============================================================================

interface AttachedContextItemProps {
  context: AttachedSavedContext
  isRemoving: boolean
  onView: () => void
  onRemove: () => void
}

export function AttachedContextItem({
  context,
  isRemoving,
  onView,
  onRemove,
}: AttachedContextItemProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 hover:bg-accent/50 transition-colors',
        isRemoving && 'opacity-50'
      )}
    >
      <FolderOpen className="h-4 w-4 text-blue-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm truncate">
            {context.name || context.slug}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatSize(context.size)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onView}
              disabled={isRemoving}
              className={cn(
                'p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </TooltipTrigger>
          <TooltipContent>View context</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRemove}
              disabled={isRemoving}
              className={cn(
                'p-1 rounded hover:bg-destructive/10 focus:outline-none focus:ring-1 focus:ring-ring',
                'transition-colors'
              )}
            >
              {isRemoving ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from context</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// =============================================================================
// Session Group
// =============================================================================

interface SessionGroupProps {
  entry: AllSessionsEntry
  generatingSessionId: string | null
  onSessionClick: (sessionWithContext: SessionWithContext) => void
  selectedIndex: number
  sessionStartIndex: number
  setSelectedIndex: (index: number) => void
}

export function SessionGroup({
  entry,
  generatingSessionId,
  onSessionClick,
  selectedIndex,
  sessionStartIndex,
  setSelectedIndex,
}: SessionGroupProps) {
  return (
    <div className="space-y-1">
      {/* Project/Worktree header */}
      <div className="text-xs text-muted-foreground px-1 flex items-center gap-1">
        <span className="font-medium">{entry.project_name}</span>
        <span>/</span>
        <span>{entry.worktree_name}</span>
      </div>

      {/* Sessions in this group */}
      <div className="space-y-1">
        {entry.sessions.map((session, idx) => {
          const hasMessages = session.messages.length > 0
          const isDisabled = !hasMessages || generatingSessionId !== null
          const isGenerating = generatingSessionId === session.id
          const flatIndex = sessionStartIndex + idx

          return (
            <button
              key={session.id}
              data-load-item-index={flatIndex}
              className={cn(
                'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
                'hover:bg-accent focus:outline-none',
                flatIndex === selectedIndex && 'bg-accent',
                isDisabled && 'opacity-50 cursor-not-allowed'
              )}
              onClick={() =>
                onSessionClick({
                  session,
                  worktreeId: entry.worktree_id,
                  worktreePath: entry.worktree_path,
                  projectName: entry.project_name,
                })
              }
              onMouseEnter={() => setSelectedIndex(flatIndex)}
              disabled={isDisabled}
            >
              {isGenerating ? (
                <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
              ) : (
                <MessageSquare className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {session.name}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {hasMessages
                    ? `${session.messages.length} messages`
                    : 'No messages'}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
