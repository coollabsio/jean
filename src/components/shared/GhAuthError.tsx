import { LogIn, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

interface GhAuthErrorProps {
  onLogin: () => void
  isGhInstalled: boolean
}

/**
 * Shared component displayed when a GitHub CLI command fails due to
 * missing authentication or missing installation.
 */
export function GhAuthError({ onLogin, isGhInstalled }: GhAuthErrorProps) {
  const openPreferences = useUIStore(state => state.setPreferencesOpen)

  if (!isGhInstalled) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-3">
        <Download className="h-5 w-5 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            GitHub CLI not installed
          </p>
          <p className="text-xs text-muted-foreground">
            Install the GitHub CLI to access issues and pull requests
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openPreferences(true)}
        >
          Open Settings
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-3">
      <LogIn className="h-5 w-5 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          GitHub CLI not authenticated
        </p>
        <p className="text-xs text-muted-foreground">
          Sign in to access issues and pull requests
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onLogin}>
        Sign in to GitHub
      </Button>
    </div>
  )
}
