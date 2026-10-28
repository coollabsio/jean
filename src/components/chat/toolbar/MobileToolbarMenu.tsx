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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
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

  const trigger = (
    <button
      type="button"
      aria-label="More actions"
      className="flex @xl:hidden h-8 items-center gap-1 rounded-l-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      disabled={isDisabled}
      onClick={isMobile ? () => setMenuOpen(true) : undefined}
    >
      <Wand2 className="h-4 w-4" />
    </button>
  )

  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[75svh] overflow-hidden rounded-t-xl p-0"
            showCloseButton={false}
          >
            <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
              <SheetTitle>Magic</SheetTitle>
              <SheetDescription className="sr-only">
                Git, pull request, release, and investigation actions.
              </SheetDescription>
            </SheetHeader>
            <div className="overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
              {magicColumns.all.map(section => (
                <section key={section.header} aria-label={section.header}>
                  <h3 className="px-3 pt-3 pb-1 text-xs text-muted-foreground">
                    {section.header}
                  </h3>
                  {section.options.map(option => {
                    const Icon = option.icon
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={isMagicOptionUnavailable(
                          option.id,
                          availability
                        )}
                        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left active:bg-accent disabled:opacity-40"
                        onClick={() => {
                          setMenuOpen(false)
                          handlers[option.id]()
                        }}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm">{option.label}</span>
                      </button>
                    )
                  })}
                </section>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </>
    )
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(80vh,640px)] w-56 overflow-y-auto"
      >
        {magicColumns.all.map((section, sectionIndex) => (
          <Fragment key={section.header}>
            {sectionIndex > 0 && <DropdownMenuSeparator />}
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
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
                  <span className="ml-auto text-xs text-muted-foreground/70">
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
