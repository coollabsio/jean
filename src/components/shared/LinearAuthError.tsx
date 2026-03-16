import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

/**
 * Shown when Linear API key is not configured or invalid for a project.
 */
export function LinearAuthError() {
  const openPreferencesPane = useUIStore(state => state.openPreferencesPane)

  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-3">
      <KeyRound className="h-5 w-5 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Linear API key not configured
        </p>
        <p className="text-xs text-muted-foreground">
          Add your Linear personal API key in Settings &rarr; Integrations
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openPreferencesPane('integrations')}
      >
        Open Settings
      </Button>
    </div>
  )
}
