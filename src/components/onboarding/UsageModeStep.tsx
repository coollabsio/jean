/**
 * First onboarding step: local Jean vs remote control.
 *
 * Local continues into WSL (Windows) / CLI setup.
 * Remote continues into jean-server install or existing Web Access URL.
 */

import { Monitor, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useState } from 'react'

export type OnboardingUsageMode = 'local' | 'remote'

interface UsageModeStepProps {
  onSelect: (mode: OnboardingUsageMode) => void
}

export function UsageModeStep({ onSelect }: UsageModeStepProps) {
  const [mode, setMode] = useState<OnboardingUsageMode>('local')

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h3 className="text-lg font-semibold">How will you use Jean?</h3>
        <p className="text-muted-foreground text-sm">
          Use this computer for development, or connect to a Jean server
          elsewhere. You can add more connections later from the title bar.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setMode('local')}
          className={`flex flex-col items-center gap-3 rounded-lg border-2 p-4 text-left transition-colors ${
            mode === 'local'
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-muted-foreground/30'
          }`}
        >
          <Monitor className="h-8 w-8 text-muted-foreground" />
          <div className="text-center">
            <div className="font-medium">Local</div>
            <div className="text-muted-foreground mt-1 text-xs">
              Install AI CLIs and run projects on this machine
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setMode('remote')}
          className={`flex flex-col items-center gap-3 rounded-lg border-2 p-4 text-left transition-colors ${
            mode === 'remote'
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-muted-foreground/30'
          }`}
        >
          <Server className="h-8 w-8 text-muted-foreground" />
          <div className="text-center">
            <div className="font-medium">Remote</div>
            <div className="text-muted-foreground mt-1 text-xs">
              Control a jean-server via SSH install or Web Access URL
            </div>
          </div>
        </button>
      </div>

      <Button className="w-full" size="lg" onClick={() => onSelect(mode)}>
        Continue
      </Button>
    </div>
  )
}
