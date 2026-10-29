import { LogIn, Download } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'
import { IntegrationNotice } from './IntegrationNotice'

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
      <IntegrationNotice
        icon={Download}
        title="GitHub CLI not installed"
        description="Install the GitHub CLI to access issues and pull requests"
        actionLabel="Open Settings"
        onAction={() => openPreferences(true)}
      />
    )
  }

  return (
    <IntegrationNotice
      icon={LogIn}
      title="GitHub CLI not authenticated"
      description="Sign in to access issues and pull requests"
      actionLabel="Sign in to GitHub"
      onAction={onLogin}
    />
  )
}
