import { useCallback, useEffect } from 'react'
import { Bot, Loader2, Rabbit, ShieldCheck } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useCodeRabbitCliStatus } from '@/services/coderabbit-cli'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'

interface ReviewMethodModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAiReview: () => void
  onFinalReview: () => void
  onCodeRabbitCliReview: () => void
  onCodeRabbitPrReview: () => void
  codeRabbitPrAvailable: boolean
}

export function ReviewMethodModal({
  open,
  onOpenChange,
  onAiReview,
  onFinalReview,
  onCodeRabbitCliReview,
  onCodeRabbitPrReview,
  codeRabbitPrAvailable,
}: ReviewMethodModalProps) {
  const isMobile = useIsMobile()
  const keyboardShortcutsEnabled = isNativeApp() && !isMobile
  const { data: coderabbitStatus, isLoading } = useCodeRabbitCliStatus({
    enabled: open,
  })
  const codeRabbitReady = Boolean(coderabbitStatus?.installed)

  const choose = useCallback(
    (handler: () => void) => {
      onOpenChange(false)
      handler()
    },
    [onOpenChange]
  )

  useEffect(() => {
    if (!open || !keyboardShortcutsEnabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return
      }

      if (event.key === '1') {
        event.preventDefault()
        event.stopPropagation()
        choose(onAiReview)
        return
      }

      if (event.key === '2') {
        event.preventDefault()
        event.stopPropagation()
        choose(onFinalReview)
        return
      }

      if (event.key === '3' && codeRabbitReady && !isLoading) {
        event.preventDefault()
        event.stopPropagation()
        choose(onCodeRabbitCliReview)
        return
      }

      if (event.key === '4' && codeRabbitPrAvailable) {
        event.preventDefault()
        event.stopPropagation()
        choose(onCodeRabbitPrReview)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [
    codeRabbitReady,
    isLoading,
    onAiReview,
    onFinalReview,
    onCodeRabbitCliReview,
    onCodeRabbitPrReview,
    codeRabbitPrAvailable,
    choose,
    keyboardShortcutsEnabled,
    open,
  ])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(360px,calc(100vw-32px))] gap-3 p-4 sm:max-w-[360px]">
        <DialogHeader className="space-y-1 pr-6">
          <DialogTitle className="text-base font-semibold">
            Review with
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">
            Choose the reviewer for this worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 gap-2">
          <ReviewChoice
            icon={<Bot className="size-4" />}
            title="Jean review"
            subtitle="Reviews your current branch against its base, including uncommitted changes"
            badge="Default"
            shortcut={keyboardShortcutsEnabled ? '1' : undefined}
            onClick={() => choose(onAiReview)}
          />

          <ReviewChoice
            icon={<ShieldCheck className="size-4" />}
            title="Final review"
            subtitle="Read-only merge-readiness audit in a new session"
            shortcut={keyboardShortcutsEnabled ? '2' : undefined}
            onClick={() => choose(onFinalReview)}
          />

          <CodeRabbitChoice
            icon={
              isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rabbit className="size-4" />
              )
            }
            cliDisabled={isLoading || !codeRabbitReady}
            cliSubtitle={
              codeRabbitReady ? 'Local CLI' : 'Install/select in Settings'
            }
            prDisabled={!codeRabbitPrAvailable}
            prSubtitle={
              codeRabbitPrAvailable
                ? 'Add @coderabbitai review comment'
                : 'Open or link a PR in Jean first'
            }
            showShortcuts={keyboardShortcutsEnabled}
            onCliReview={() => choose(onCodeRabbitCliReview)}
            onPrReview={() => choose(onCodeRabbitPrReview)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CodeRabbitChoice({
  icon,
  cliDisabled,
  cliSubtitle,
  prDisabled,
  prSubtitle,
  showShortcuts,
  onCliReview,
  onPrReview,
}: {
  icon: React.ReactNode
  cliDisabled?: boolean
  cliSubtitle: string
  prDisabled?: boolean
  prSubtitle: string
  showShortcuts: boolean
  onCliReview: () => void
  onPrReview: () => void
}) {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-none">
          CodeRabbit
        </span>
        <span className="mt-1 block text-xs leading-snug text-muted-foreground">
          Trigger via CLI or PR comment
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={cliDisabled}
          onClick={onCliReview}
          title={cliSubtitle}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-muted-foreground transition-colors',
            'hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            cliDisabled && 'cursor-not-allowed opacity-50 hover:bg-background'
          )}
        >
          CLI
          {showShortcuts && (
            <Kbd className="h-4 min-w-4 px-1 text-[10px]">3</Kbd>
          )}
        </button>
        <button
          type="button"
          disabled={prDisabled}
          onClick={onPrReview}
          title={prSubtitle}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-muted-foreground transition-colors',
            'hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            prDisabled && 'cursor-not-allowed opacity-50 hover:bg-background'
          )}
        >
          PR
          {showShortcuts && (
            <Kbd className="h-4 min-w-4 px-1 text-[10px]">4</Kbd>
          )}
        </button>
      </span>
    </div>
  )
}

function ReviewChoice({
  icon,
  title,
  subtitle,
  badge,
  shortcut,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  badge?: string
  shortcut?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors',
        'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium leading-none">
          {title}
          {badge && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-snug text-muted-foreground">
          {subtitle}
        </span>
      </span>
      {shortcut && <Kbd className="shrink-0 text-[10px]">{shortcut}</Kbd>}
    </button>
  )
}
