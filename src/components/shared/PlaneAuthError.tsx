import { KeyRound } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'
import { IntegrationNotice } from './IntegrationNotice'

/** Shown when the Plane API key or workspace is not configured or is invalid. */
export function PlaneAuthError() {
  const openPreferencesPane = useUIStore(state => state.openPreferencesPane)

  return (
    <IntegrationNotice
      icon={KeyRound}
      title="Plane access is not configured"
      description={
        <>
          Add a Plane API key and workspace slug in Settings &rarr;
          Integrations. Self-hosted Plane also needs its base URL.
        </>
      }
      actionLabel="Open Integrations"
      onAction={() => openPreferencesPane('integrations')}
    />
  )
}
