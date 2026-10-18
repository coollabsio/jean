import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useUIStore } from '@/store/ui-store'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { formatShortcutDisplay } from '@/types/keybindings'
import { isNativeApp } from '@/lib/environment'

const MAGIC_MENU_FEATURES = [
  'Commit, push, and open pull requests',
  'Save context, create recaps, and resolve conflicts',
  'Review, merge, and investigate issues',
] as const

export function FeatureTourDialog() {
  const featureTourOpen = useUIStore(state => state.featureTourOpen)
  const [page, setPage] = useState(0)
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const showShortcut = isNativeApp()

  const handleClose = useCallback(() => {
    setPage(0)
    useUIStore.getState().setFeatureTourOpen(false)

    // Persist a dismissal even when the preferences query is still loading.
    if (preferences?.has_seen_feature_tour !== true) {
      patchPreferences.mutate({ has_seen_feature_tour: true })
    }
  }, [preferences, patchPreferences])

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (page === 0) setPage(1)
      else handleClose()
    }
  })

  useEffect(() => {
    if (!featureTourOpen) return
    const handleKeyDown = (event: KeyboardEvent) => onKeyDown(event)
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [featureTourOpen])

  return (
    <Dialog
      open={featureTourOpen}
      onOpenChange={open => !open && handleClose()}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] gap-3 overflow-y-auto p-4 sm:max-w-md sm:gap-4 sm:p-5"
        showCloseButton
      >
        <div className="flex justify-center gap-1.5" aria-label="Tour progress">
          {[0, 1].map(index => (
            <span
              key={index}
              className={`size-1.5 rounded-full ${
                index === page ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            />
          ))}
        </div>

        <DialogHeader className="pr-7">
          <DialogTitle>
            {page === 0 ? 'Meet the Magic Menu' : 'Automate with jean.json'}
          </DialogTitle>
          <DialogDescription>
            {page === 0
              ? 'Make it your first stop for everyday development tasks.'
              : 'Keep project setup and run commands in your repository.'}
          </DialogDescription>
        </DialogHeader>

        {page === 0 ? (
          <>
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 sm:p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">
                  Use the Magic Menu often
                </span>
                {showShortcut && (
                  <Kbd className="h-6 shrink-0 px-2 text-xs font-medium">
                    {formatShortcutDisplay('mod+m')}
                  </Kbd>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Press the shortcut from any project instead of searching through
                menus.
              </p>
            </div>

            <ul className="space-y-2" aria-label="Magic Menu features">
              {MAGIC_MENU_FEATURES.map(feature => (
                <li
                  key={feature}
                  className="flex items-start gap-2 text-sm text-foreground/90"
                >
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 sm:p-4">
              <code className="text-sm font-semibold">jean.json</code>
              <p className="mt-1 text-xs text-muted-foreground">
                Add it to the project root so every worktree uses the same
                commands.
              </p>
            </div>

            <ul className="space-y-2" aria-label="jean.json features">
              <li className="flex items-start gap-2 text-sm text-foreground/90">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <strong>setup</strong> prepares each new worktree.
                </span>
              </li>
              <li className="flex items-start gap-2 text-sm text-foreground/90">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <strong>run</strong> starts your development environment.
                </span>
              </li>
            </ul>
          </>
        )}

        <div className="mt-1 flex gap-2">
          {page === 1 && (
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setPage(0)}
            >
              Back
            </Button>
          )}
          <Button
            className="flex-1"
            onClick={() => (page === 0 ? setPage(1) : handleClose())}
          >
            {page === 0 ? 'Next' : 'Got it'}
            {showShortcut && <Kbd className="ml-2 h-4 px-1 text-[10px]">↵</Kbd>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
