import {
  CircleDot,
  Eye,
  FileText,
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
} from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SeverityBadge } from '@/components/worktree/NewWorktreeItems'
import type {
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
  worktreeName: string
  projectName: string
}

/** Format file size to human-readable string */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// =============================================================================
// Shared row actions
// =============================================================================

const ACTION_BUTTON_CLASS =
  'p-1 rounded focus:outline-none focus:ring-1 focus:ring-ring transition-colors'

function ActionButton({
  label,
  onClick,
  disabled,
  destructive = false,
  children,
}: {
  label: string
  onClick: () => void
  disabled: boolean
  destructive?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            ACTION_BUTTON_CLASS,
            destructive ? 'hover:bg-destructive/10' : 'hover:bg-accent'
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** View, optional refresh, and remove buttons for a loaded context row */
function ContextItemActions({
  refreshLabel,
  isLoading = false,
  isRemoving,
  onView,
  onRefresh,
  onRemove,
}: {
  refreshLabel?: string
  isLoading?: boolean
  isRemoving: boolean
  onView: () => void
  onRefresh?: () => void
  onRemove: () => void
}) {
  const isDisabled = isLoading || isRemoving
  const spinner = (
    <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
  )

  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      <ActionButton label="View context" onClick={onView} disabled={isDisabled}>
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
      </ActionButton>
      {onRefresh && refreshLabel && (
        <ActionButton
          label={refreshLabel}
          onClick={onRefresh}
          disabled={isDisabled}
        >
          {isLoading ? (
            spinner
          ) : (
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </ActionButton>
      )}
      <ActionButton
        label="Remove from context"
        onClick={onRemove}
        disabled={isDisabled}
        destructive
      >
        {isRemoving ? (
          spinner
        ) : (
          <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        )}
      </ActionButton>
    </div>
  )
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
      <CircleDot className="h-4 w-4 text-success flex-shrink-0" />
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
      <ContextItemActions
        refreshLabel="Refresh issue"
        isLoading={isLoading}
        isRemoving={isRemoving}
        onView={onView}
        onRefresh={onRefresh}
        onRemove={onRemove}
      />
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
      <GitPullRequest className="h-4 w-4 text-success flex-shrink-0" />
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
      <ContextItemActions
        refreshLabel="Refresh PR"
        isLoading={isLoading}
        isRemoving={isRemoving}
        onView={onView}
        onRefresh={onRefresh}
        onRemove={onRemove}
      />
    </div>
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
      <Shield className="h-4 w-4 text-warning flex-shrink-0" />
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
      <ContextItemActions
        refreshLabel="Refresh alert"
        isLoading={isLoading}
        isRemoving={isRemoving}
        onView={onView}
        onRefresh={onRefresh}
        onRemove={onRemove}
      />
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
      <ShieldAlert className="h-4 w-4 text-warning flex-shrink-0" />
      <SeverityBadge severity={context.severity} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{context.ghsaId}</span>
          <span className="text-xs text-muted-foreground truncate">
            {context.summary}
          </span>
        </div>
      </div>
      <ContextItemActions
        refreshLabel="Refresh advisory"
        isLoading={isLoading}
        isRemoving={isRemoving}
        onView={onView}
        onRefresh={onRefresh}
        onRemove={onRemove}
      />
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
        data-item-index={index}
        className="w-full flex items-start gap-3 px-3 py-2 bg-accent"
      >
        <FolderOpen className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <input
            ref={editInputRef}
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={onRenameKeyDown}
            aria-label="Rename context"
            className="w-full text-base font-medium bg-transparent border-b border-primary outline-none md:text-sm"
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
    <div
      data-item-index={index}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors group',
        'hover:bg-accent',
        isSelected && 'bg-accent',
        isLoading && 'opacity-50'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        className="flex items-start gap-3 flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
        ) : (
          <FolderOpen className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
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
      </button>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Preview"
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
              type="button"
              aria-label="Rename"
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
              type="button"
              aria-label="Delete"
              onClick={onDelete}
              className="p-1 rounded hover:bg-destructive/10 focus:outline-none"
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </div>
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
      <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
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
      <ContextItemActions
        isRemoving={isRemoving}
        onView={onView}
        onRemove={onRemove}
      />
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
  onGenerateSessionContext?: (sessionWithContext: SessionWithContext) => void
  selectedIndex: number
  sessionStartIndex: number
  setSelectedIndex: (index: number) => void
}

export function SessionGroup({
  entry,
  generatingSessionId,
  onSessionClick,
  onGenerateSessionContext,
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
          const sessionWithContext: SessionWithContext = {
            session,
            worktreeId: entry.worktree_id,
            worktreePath: entry.worktree_path,
            worktreeName: entry.worktree_name,
            projectName: entry.project_name,
          }

          return (
            <div
              key={session.id}
              data-item-index={flatIndex}
              className={cn(
                'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
                'hover:bg-accent',
                flatIndex === selectedIndex && 'bg-accent',
                isDisabled && 'opacity-50'
              )}
              onMouseEnter={() => setSelectedIndex(flatIndex)}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      'flex min-w-0 flex-1',
                      isDisabled && 'cursor-not-allowed'
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-start gap-3 min-w-0 text-left focus:outline-none',
                        isDisabled && 'pointer-events-none cursor-not-allowed'
                      )}
                      onClick={() => onSessionClick(sessionWithContext)}
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
                            ? `${session.messages.length} messages · inject pointer`
                            : 'No messages'}
                        </div>
                      </div>
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Inject session as MCP context pointer
                </TooltipContent>
              </Tooltip>
              {onGenerateSessionContext && hasMessages && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'p-1 rounded hover:bg-background/80 text-muted-foreground hover:text-foreground flex-shrink-0 mt-0.5',
                        isDisabled && 'cursor-not-allowed opacity-50'
                      )}
                      onClick={e => {
                        e.stopPropagation()
                        onGenerateSessionContext(sessionWithContext)
                      }}
                      disabled={isDisabled}
                      aria-label="Generate full context summary"
                    >
                      <FileText className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    Generate full context summary (AI)
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
