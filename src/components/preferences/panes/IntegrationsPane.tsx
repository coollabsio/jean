import React, { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { testSentryAuthToken } from '@/services/sentry'
import { SettingsSection } from '../SettingsSection'

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="space-y-2">
    <div className="space-y-0.5">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
    </div>
    {children}
  </div>
)

export const IntegrationsPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  const [localLinearApiKey, setLocalLinearApiKey] = useState<string | null>(
    null
  )
  const [showLinearApiKey, setShowLinearApiKey] = useState(false)
  const [localSentryAuthToken, setLocalSentryAuthToken] = useState<
    string | null
  >(null)
  const [showSentryAuthToken, setShowSentryAuthToken] = useState(false)
  const [isTestingSentry, setIsTestingSentry] = useState(false)

  const currentGlobalKey = preferences?.linear_api_key ?? ''
  const displayedLinearApiKey = localLinearApiKey ?? currentGlobalKey
  const linearApiKeyChanged =
    localLinearApiKey !== null && localLinearApiKey !== currentGlobalKey
  const currentSentryAuthToken = preferences?.sentry_auth_token ?? ''
  const displayedSentryAuthToken =
    localSentryAuthToken ?? currentSentryAuthToken
  const sentryAuthTokenChanged =
    localSentryAuthToken !== null &&
    localSentryAuthToken !== currentSentryAuthToken

  const handleSaveLinearApiKey = () => {
    if (localLinearApiKey === null) return
    patchPreferences.mutate(
      { linear_api_key: localLinearApiKey.trim() || null },
      { onSuccess: () => setLocalLinearApiKey(null) }
    )
  }

  const handleClearLinearApiKey = () => {
    patchPreferences.mutate(
      { linear_api_key: null },
      { onSuccess: () => setLocalLinearApiKey(null) }
    )
  }

  const handleSaveSentryAuthToken = async () => {
    const authToken = displayedSentryAuthToken.trim()
    if (!authToken) return

    setIsTestingSentry(true)
    try {
      const projects = await testSentryAuthToken(authToken)
      const showSuccess = () =>
        toast.success(
          `Sentry token verified — ${projects.length} project${projects.length === 1 ? '' : 's'} available`,
          {
            description:
              'Choose the matching Sentry project in each Jean project’s settings.',
          }
        )
      if (sentryAuthTokenChanged) {
        patchPreferences.mutate(
          { sentry_auth_token: authToken },
          {
            onSuccess: () => {
              setLocalSentryAuthToken(null)
              showSuccess()
            },
          }
        )
      } else {
        showSuccess()
      }
    } catch (error) {
      toast.error('Sentry token test failed', {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsTestingSentry(false)
    }
  }

  const handleClearSentryAuthToken = () => {
    patchPreferences.mutate(
      { sentry_auth_token: null },
      { onSuccess: () => setLocalSentryAuthToken(null) }
    )
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Linear"
        anchorId="pref-integrations-section-linear"
      >
        <InlineField
          label="Personal API Key"
          description={
            <>
              Your Linear personal API key, used by all projects unless
              overridden in project settings. Get one from{' '}
              <a
                href="https://linear.app/settings/api"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                Linear Settings
              </a>
            </>
          }
        >
          <div className="flex items-center gap-2">
            <Input
              type={showLinearApiKey ? 'text' : 'password'}
              placeholder="lin_api_..."
              value={displayedLinearApiKey}
              onChange={e => setLocalLinearApiKey(e.target.value)}
              className="flex-1 text-base md:text-sm font-mono"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowLinearApiKey(!showLinearApiKey)}
            >
              {showLinearApiKey ? 'Hide' : 'Show'}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveLinearApiKey}
              disabled={!linearApiKeyChanged || patchPreferences.isPending}
            >
              {patchPreferences.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
            {currentGlobalKey && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearLinearApiKey}
                disabled={patchPreferences.isPending}
              >
                Remove
              </Button>
            )}
          </div>
        </InlineField>
      </SettingsSection>
      <SettingsSection
        title="Sentry"
        anchorId="pref-integrations-section-sentry"
      >
        <InlineField
          label="Auth Token"
          description={
            <>
              Used by all projects unless overridden in project settings. The
              token needs <code>org:read</code> to discover projects and{' '}
              <code>event:read</code> to load issues. Personal tokens follow
              your Sentry account memberships; they are not tied to one
              project. Create one in{' '}
              <a
                href="https://sentry.io/settings/account/api/auth-tokens/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                Sentry Auth Tokens
              </a>
              .
            </>
          }
        >
          <div className="flex items-center gap-2">
            <Input
              type={showSentryAuthToken ? 'text' : 'password'}
              placeholder="sntrys_..."
              value={displayedSentryAuthToken}
              onChange={event => setLocalSentryAuthToken(event.target.value)}
              className="flex-1 text-base md:text-sm font-mono"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSentryAuthToken(!showSentryAuthToken)}
            >
              {showSentryAuthToken ? 'Hide' : 'Show'}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveSentryAuthToken}
              disabled={
                !displayedSentryAuthToken.trim() ||
                patchPreferences.isPending ||
                isTestingSentry
              }
            >
              {(patchPreferences.isPending || isTestingSentry) && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save & Test
            </Button>
            {currentSentryAuthToken && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearSentryAuthToken}
                disabled={patchPreferences.isPending}
              >
                Remove
              </Button>
            )}
          </div>
        </InlineField>
      </SettingsSection>
    </div>
  )
}
