import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useUIStore } from '@/store/ui-store'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { formatShortcutDisplay, type ShortcutString } from '@/types/keybindings'

interface ShortcutRow {
  shortcut: ShortcutString
  label: string
}

const steps = [
  {
    title: 'Getting Started',
    description: 'Essential shortcuts to start working',
    shortcuts: [
      {
        shortcut: 'mod+n' as ShortcutString,
        label: 'New worktree (own branch)',
      },
      { shortcut: 'mod+t' as ShortcutString, label: 'New session in worktree' },
      { shortcut: 'mod+k' as ShortcutString, label: 'Command palette' },
      { shortcut: 'mod+l' as ShortcutString, label: 'Focus chat input' },
    ] satisfies ShortcutRow[],
  },
  {
    title: 'Canvas Navigation',
    description: 'Move between sessions on the canvas',
    shortcuts: [
      {
        shortcut: 'ArrowLeft/ArrowRight' as ShortcutString,
        label: 'Navigate left / right',
      },
      {
        shortcut: 'ArrowUp/ArrowDown' as ShortcutString,
        label: 'Navigate up / down',
      },
      { shortcut: 'Enter' as ShortcutString, label: 'Open selected session' },
      { shortcut: '/' as ShortcutString, label: 'Search sessions' },
    ] satisfies ShortcutRow[],
  },
  {
    title: 'Session Shortcuts',
    description: 'Quick actions on selected sessions',
    shortcuts: [
      { shortcut: 'mod+Enter' as ShortcutString, label: 'Approve plan' },
      { shortcut: 'mod+y' as ShortcutString, label: 'Approve plan (YOLO)' },
      { shortcut: 'mod+s' as ShortcutString, label: 'Toggle session label' },
      {
        shortcut: 'mod+w' as ShortcutString,
        label: 'Close session or worktree',
      },
    ] satisfies ShortcutRow[],
  },
  {
    title: 'Magic & Git',
    description: 'Quick access to git and tooling commands',
    shortcuts: [
      {
        shortcut: 'mod+m' as ShortcutString,
        label: 'Open magic commands menu',
      },
      { shortcut: 'mod+shift+c' as ShortcutString, label: 'Commit' },
      { shortcut: 'mod+g' as ShortcutString, label: 'Git diff' },
      { shortcut: 'mod+r' as ShortcutString, label: 'Run script' },
      { shortcut: 'mod+o' as ShortcutString, label: 'Open in...' },
    ] satisfies ShortcutRow[],
  },
  {
    title: 'Automation',
    description: 'Automate your workflow with jean.json',
    shortcuts: [
      {
        shortcut: 'jean.json' as ShortcutString,
        label: 'Config file in your project root',
      },
      {
        shortcut: 'setup' as ShortcutString,
        label: 'Runs after each worktree is created',
      },
      {
        shortcut: 'run' as ShortcutString,
        label: 'Dev server script, launched via ⌘R',
      },
    ] satisfies ShortcutRow[],
  },
] as const

function formatArrowKeys(shortcut: string): string {
  if (shortcut === 'ArrowLeft/ArrowRight') return '← →'
  if (shortcut === 'ArrowUp/ArrowDown') return '↑ ↓'
  return formatShortcutDisplay(shortcut as ShortcutString)
}

export function FeatureTourDialog() {
  return <FeatureTourDialogContent />
}

function FeatureTourDialogContent() {
  const featureTourOpen = useUIStore(state => state.featureTourOpen)
  const [stepIndex, setStepIndex] = useState(0)
  const { setFeatureTourOpen } = useUIStore.getState()
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  const markSeen = useCallback(() => {
    if (preferences && !preferences.has_seen_feature_tour) {
      patchPreferences.mutate({ has_seen_feature_tour: true })
    }
  }, [preferences, patchPreferences])

  const handleClose = useCallback(() => {
    setFeatureTourOpen(false)
    markSeen()
  }, [setFeatureTourOpen, markSeen])

  const handleNext = useCallback(() => {
    if (stepIndex < steps.length - 1) {
      setStepIndex(i => i + 1)
    } else {
      handleClose()
    }
  }, [stepIndex, handleClose])

  // Keyboard navigation: arrows, Enter, S
  useEffect(() => {
    if (!featureTourOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setStepIndex(i => Math.min(i + 1, steps.length - 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setStepIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleNext()
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [featureTourOpen, handleNext, handleClose])

  const step = steps[stepIndex] as (typeof steps)[number]
  const isLastStep = stepIndex === steps.length - 1

  return (
    <Dialog
      open={featureTourOpen}
      onOpenChange={open => !open && handleClose()}
    >
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          {/* Step dots */}
          <div className="flex items-center justify-center gap-1.5 mb-2">
            {steps.map((s, i) => (
              <button
                key={s.title}
                type="button"
                onClick={() => setStepIndex(i)}
                className={`size-2 rounded-full transition-colors cursor-pointer hover:bg-primary/70 ${
                  i === stepIndex
                    ? 'bg-primary'
                    : i < stepIndex
                      ? 'bg-primary/40'
                      : 'bg-muted-foreground/30'
                }`}
              />
            ))}
          </div>
          <DialogTitle className="text-lg">{step.title}</DialogTitle>
          <DialogDescription>{step.description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-[300px] py-3 space-y-2">
          {step.shortcuts.map(item => (
            <div
              key={item.shortcut}
              className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/30 px-3 py-2.5"
            >
              <Kbd className="h-6 min-w-8 shrink-0 px-2 text-xs font-medium">
                {formatArrowKeys(item.shortcut)}
              </Kbd>
              <span className="text-sm text-foreground/80">{item.label}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" size="sm" onClick={handleClose}>
            Skip <Kbd className="ml-1 h-4 px-1 text-[10px]">S</Kbd>
          </Button>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd className="h-5 px-1 text-[10px]">←</Kbd>
            <Kbd className="h-5 px-1 text-[10px]">→</Kbd>
          </div>
          <Button size="sm" className="w-18" onClick={handleNext}>
            {isLastStep ? 'Done' : 'Next'}{' '}
            <Kbd className="ml-1 h-4 px-1 text-[10px]">↵</Kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
