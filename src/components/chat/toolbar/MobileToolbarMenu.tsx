import { Fragment, useMemo, useState } from 'react'
import { Wand2 } from '@/components/icons/reicon'
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
import {
  buildMagicColumns,
  isMagicOptionUnavailable,
  type MagicMenuOption,
} from '@/components/magic/magic-options'

interface MobileToolbarMenuProps {
  isDisabled: boolean
  hasOpenPr: boolean
  hasIssueContexts: boolean
  hasSentryContexts?: boolean
  hasPrContexts: boolean
  hasAdvisoryContexts?: boolean

  onSaveContext: () => void
  onLoadContext: () => void
  onCommit: () => void
  onCommitAndPush: () => void
  onRevertLastCommit: () => void
  onOpenPr: () => void
  onReview: () => void
  onMerge: () => void
  onMergePr: () => void
  handleSyncClick: () => void
  handlePullClick: () => void
  handlePushClick: () => void
}

export function MobileToolbarMenu({
  isDisabled,
  hasOpenPr,
  hasIssueContexts,
  hasSentryContexts = false,
  hasPrContexts,
  hasAdvisoryContexts = false,
  onSaveContext,
  onLoadContext,
  onCommit,
  onCommitAndPush,
  onRevertLastCommit,
  onOpenPr,
  onReview,
  onMerge,
  onMergePr,
  handleSyncClick,
  handlePullClick,
  handlePushClick,
}: MobileToolbarMenuProps) {
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  const magicColumns = useMemo(() => buildMagicColumns(hasOpenPr), [hasOpenPr])
  const availability = {
    hasOpenPr,
    hasIssueContexts,
    hasSentryContexts,
    hasPrContexts,
    hasAdvisoryContexts,
  }

  const dispatchMagicCommand = (detail: Record<string, unknown>) =>
    window.dispatchEvent(new CustomEvent('magic-command', { detail }))

  // Record over every menu option: a new shared item fails typecheck here
  // until it gets a mobile handler.
  const handlers: Record<MagicMenuOption, () => void> = {
    'save-context': onSaveContext,
    'inject-session': onLoadContext,
    'linked-projects': () =>
      useUIStore.getState().setLinkedProjectsModalOpen(true),
    'fork-session': () => dispatchMagicCommand({ command: 'fork-session' }),
    'check-github-issues': () =>
      dispatchMagicCommand({ command: 'check-github-issues' }),
    commit: onCommit,
    'commit-and-push': onCommitAndPush,
    'commit-in-session': () =>
      dispatchMagicCommand({ command: 'commit-in-session' }),
    'comment-and-close-issue': () =>
      dispatchMagicCommand({ command: 'comment-and-close-issue' }),
    'revert-last-commit': onRevertLastCommit,
    sync: handleSyncClick,
    pull: handlePullClick,
    push: handlePushClick,
    'open-pr': onOpenPr,
    'link-pr': () =>
      window.dispatchEvent(
        new CustomEvent('magic-option', { detail: 'link-pr' })
      ),
    review: onReview,
    'review-comments': () =>
      useUIStore.getState().setReviewCommentsModalOpen(true),
    'merge-pr': onMergePr,
    'release-notes': () => useUIStore.getState().setReleaseNotesModalOpen(true),
    'update-pr': () => useUIStore.getState().setUpdatePrModalOpen(true),
    'pre-release-review': () =>
      dispatchMagicCommand({ command: 'pre-release-review' }),
    'investigate-issue': () =>
      dispatchMagicCommand({
        command: 'investigate',
        type: hasIssueContexts ? 'issue' : 'sentry-issue',
      }),
    'investigate-pr': () =>
      dispatchMagicCommand({ command: 'investigate', type: 'pr' }),
    'investigate-advisory': () =>
      dispatchMagicCommand({ command: 'investigate', type: 'advisory' }),
    merge: onMerge,
    'resolve-conflicts': () =>
      useUIStore.getState().setResolveConflictsDialogOpen(true),
  }

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
      <DropdownMenuContent
        align={isMobile ? 'end' : 'start'}
        className={cn(
          'max-h-[min(80vh,640px)] overflow-y-auto',
          isMobile ? 'w-[calc(100vw-1rem)] max-w-none grid grid-cols-2' : 'w-56'
        )}
      >
        {magicColumns.all.map((section, sectionIndex) => (
          <Fragment key={section.header}>
            {sectionIndex > 0 && (
              <DropdownMenuSeparator className="col-span-2" />
            )}
            <div className="col-span-2 px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {section.header}
            </div>
            {section.options.map(option => {
              const Icon = option.icon
              return (
                <DropdownMenuItem
                  key={option.id}
                  disabled={isMagicOptionUnavailable(option.id, availability)}
                  onSelect={handlers[option.id]}
                >
                  <Icon className="h-4 w-4" />
                  {option.label}
                  <span
                    className={cn(
                      'ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded',
                      isMobile && 'hidden'
                    )}
                  >
                    {option.key}
                  </span>
                </DropdownMenuItem>
              )
            })}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
