import { LogIn, Download } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'
import { IntegrationNotice } from './IntegrationNotice'

interface GlabAuthErrorProps {
  onLogin: () => void
  isGlabInstalled: boolean
}

/**
 * Shared component displayed when a GitLab CLI command fails due to
 * missing authentication or missing installation.
 */
export function GlabAuthError({
  onLogin,
  isGlabInstalled,
}: GlabAuthErrorProps) {
  const openPreferences = useUIStore(state => state.setPreferencesOpen)

  if (!isGlabInstalled) {
    return (
      <IntegrationNotice
        icon={Download}
        title="GitLab CLI not installed"
        description="Install the GitLab CLI to access issues and merge requests"
        actionLabel="Open Settings"
        onAction={() => openPreferences(true)}
      />
    )
  }

  return (
    <IntegrationNotice
      icon={LogIn}
      title="GitLab CLI not authenticated"
      description="Sign in to access issues and merge requests"
      actionLabel="Sign in to GitLab"
      onAction={onLogin}
    />
  )
}
