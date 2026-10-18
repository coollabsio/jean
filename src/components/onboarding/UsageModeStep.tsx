/**
 * First native onboarding step: where Jean runs AI backends.
 *
 * Local continues into WSL (Windows) / backend setup on this machine.
 * Remote installs jean-server over SSH (or connects an existing Web Access
 * URL), then continues into backend setup on that server.
 */

import { ChevronRight, Monitor, Server } from '@/components/icons/reicon'

export type OnboardingUsageMode = 'local' | 'remote'

interface UsageModeStepProps {
  onSelect: (mode: OnboardingUsageMode) => void
}

const MODES = [
  {
    id: 'local',
    icon: Monitor,
    title: 'This computer',
    hint: 'Run everything locally',
  },
  {
    id: 'remote',
    icon: Server,
    title: 'Remote server',
    hint: 'Set up over SSH',
  },
] as const

export function UsageModeStep({ onSelect }: UsageModeStepProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {MODES.map(mode => (
        <button
          key={mode.id}
          type="button"
          onClick={() => onSelect(mode.id)}
          className="group flex items-center gap-4 rounded-xl border bg-card p-5 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
            <mode.icon className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{mode.title}</span>
            <span className="block text-xs text-muted-foreground">
              {mode.hint}
            </span>
          </span>
          <ChevronRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      ))}
    </div>
  )
}
