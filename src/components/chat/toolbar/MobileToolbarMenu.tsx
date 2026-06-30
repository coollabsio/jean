import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  BookmarkPlus,
  Bug,
  Eye,
  FileText,
  FolderOpen,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Link2,
  MessageSquare,
  RefreshCw,
  Undo2,
  Wand2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

interface MobileToolbarMenuProps {
  isDisabled: boolean
  hasOpenPr: boolean
  hasIssueContexts: boolean
  hasPrContexts: boolean

  onSaveContext: () => void
  onLoadContext: () => void
  onCommit: () => void
  onCommitAndPush: () => void
  onRevertLastCommit: () => void
  onOpenPr: () => void
  onReview: () => void
  onMerge: () => void
  onMergePr: () => void
  handlePullClick: () => void
  handlePushClick: () => void
}

export function MobileToolbarMenu({
  isDisabled,
  hasOpenPr,
  hasIssueContexts,
  hasPrContexts,
  onSaveContext,
  onLoadContext,
  onCommit,
  onCommitAndPush,
  onRevertLastCommit,
  onOpenPr,
  onReview,
  onMerge,
  onMergePr,
  handlePullClick,
  handlePushClick,
}: MobileToolbarMenuProps) {
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More actions"
          className="flex @xl:hidden h-8 items-center gap-1 rounded-l-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={isDisabled}
        >
          <Wand2 className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={isMobile ? 'end' : 'start'} className="w-56">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Context
        </div>
        <DropdownMenuItem onClick={onSaveContext}>
          <BookmarkPlus className="h-4 w-4" />
          Save Context
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            S
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onLoadContext}>
          <FolderOpen className="h-4 w-4" />
          Load Context
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            L
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setMenuOpen(false)
            useUIStore.getState().setLinkedProjectsModalOpen(true)
          }}
        >
          <Link2 className="h-4 w-4" />
          Linked Projects
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            K
          </span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={() => {
            setMenuOpen(false)
            window.dispatchEvent(
              new CustomEvent('magic-command', {
                detail: { command: 'fork-session' },
              })
            )
          }}
        >
          <GitBranchPlus className="h-4 w-4" />
          Fork Session
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            W
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Commit
        </div>
        <DropdownMenuItem onClick={onCommit}>
          <GitCommitHorizontal className="h-4 w-4" />
          Commit
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            C
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCommitAndPush}>
          <GitCommitHorizontal className="h-4 w-4" />
          Commit & Push
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            P
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setMenuOpen(false)
            onRevertLastCommit()
          }}
        >
          <Undo2 className="h-4 w-4" />
          Revert Commit
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            Z
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Sync
        </div>
        <DropdownMenuItem onClick={handlePullClick}>
          <ArrowDownToLine className="h-4 w-4" />
          Pull
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            D
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handlePushClick}>
          <ArrowUpToLine className="h-4 w-4" />
          Push
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            U
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Pull Request
        </div>
        <DropdownMenuItem onClick={onOpenPr}>
          <GitPullRequest className="h-4 w-4" />
          {hasOpenPr ? 'Open' : 'Create'}
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            O
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onReview}>
          <Eye className="h-4 w-4" />
          Review
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            R
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasOpenPr}
          onClick={() => {
            setMenuOpen(false)
            useUIStore.getState().setReviewCommentsModalOpen(true)
          }}
        >
          <MessageSquare className="h-4 w-4" />
          PR Comments
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            V
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasOpenPr}
          onClick={() => {
            setMenuOpen(false)
            onMergePr()
          }}
        >
          <GitMerge className="h-4 w-4" />
          Merge
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            N
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Release
        </div>
        <DropdownMenuItem
          onClick={() => {
            setMenuOpen(false)
            useUIStore.getState().setReleaseNotesModalOpen(true)
          }}
        >
          <FileText className="h-4 w-4" />
          Release Notes
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            G
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setMenuOpen(false)
            useUIStore.getState().setUpdatePrModalOpen(true)
          }}
        >
          <RefreshCw className="h-4 w-4" />
          PR Description
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            E
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Investigate
        </div>
        <DropdownMenuItem
          disabled={!hasIssueContexts}
          onClick={() => {
            if (!hasIssueContexts) return
            setMenuOpen(false)
            window.dispatchEvent(
              new CustomEvent('magic-command', {
                detail: { command: 'investigate', type: 'issue' },
              })
            )
          }}
        >
          <Bug className="h-4 w-4" />
          Issue
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            I
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasPrContexts}
          onClick={() => {
            if (!hasPrContexts) return
            setMenuOpen(false)
            window.dispatchEvent(
              new CustomEvent('magic-command', {
                detail: { command: 'investigate', type: 'pr' },
              })
            )
          }}
        >
          <GitPullRequestArrow className="h-4 w-4" />
          PR
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            A
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Branch
        </div>
        <DropdownMenuItem onClick={onMerge}>
          <GitMerge className="h-4 w-4" />
          Merge to Base
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            M
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            useUIStore.getState().setResolveConflictsDialogOpen(true)
          }
        >
          <GitMerge className="h-4 w-4" />
          Resolve Conflicts
          <span
            className={cn(
              'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
              isMobile && 'hidden'
            )}
          >
            F
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
