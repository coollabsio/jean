import { KeyRound } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'
import { IntegrationNotice } from './IntegrationNotice'

/**
 * Shown when Linear API key is not configured or invalid for a project.
 * Mirrors SentryAuthError layout so unconfigured integrations feel consistent.
 */
export function LinearAuthError() {
  const openPreferencesPane = useUIStore(state => state.openPreferencesPane)

  return (
    <IntegrationNotice
      icon={KeyRound}
      title="Linear access is not configured"
      description={
        <>
          Add and test a personal API key in Settings &rarr; Integrations, then
          optionally filter issues by team for this Jean project.
        </>
      }
      actionLabel="Open Integrations"
      onAction={() => openPreferencesPane('integrations')}
    />
  )
}
