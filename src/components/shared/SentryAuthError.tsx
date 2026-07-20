import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'

export function SentryAuthError({
  projectId,
  error,
}: {
  projectId: string
  error: unknown
}) {
  const openPreferencesPane = useUIStore(state => state.openPreferencesPane)
  const errorMessage = error instanceof Error ? error.message : String(error)
  const needsToken = errorMessage.toLowerCase().includes('auth token')

  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-3">
      <KeyRound className="h-5 w-5 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Sentry access is not configured
        </p>
        <p className="text-xs text-muted-foreground">
          Add and test an auth token, then map this Jean project to one of the
          accessible Sentry projects.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (needsToken) {
            openPreferencesPane('integrations')
          } else {
            useProjectsStore
              .getState()
              .openProjectSettings(projectId, 'integrations')
          }
        }}
      >
        {needsToken ? 'Open Integrations' : 'Map Sentry Project'}
      </Button>
    </div>
  )
}
