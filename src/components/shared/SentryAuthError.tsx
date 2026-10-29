import { KeyRound } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { IntegrationNotice } from './IntegrationNotice'

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
    <IntegrationNotice
      icon={KeyRound}
      title="Sentry access is not configured"
      description="Add and test an auth token, then map this Jean project to one of the accessible Sentry projects."
      actionLabel={needsToken ? 'Open Integrations' : 'Map Sentry Project'}
      onAction={() => {
        if (needsToken) {
          openPreferencesPane('integrations')
        } else {
          useProjectsStore
            .getState()
            .openProjectSettings(projectId, 'integrations')
        }
      }}
    />
  )
}
