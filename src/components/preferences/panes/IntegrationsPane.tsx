import React, { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { usePreferences, usePatchPreferences } from '@/services/preferences'

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

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

  const currentGlobalKey = preferences?.linear_api_key ?? ''
  const displayedLinearApiKey = localLinearApiKey ?? currentGlobalKey
  const linearApiKeyChanged =
    localLinearApiKey !== null && localLinearApiKey !== currentGlobalKey

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

  return (
    <div className="space-y-6">
      <SettingsSection title="Linear">
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
              className="flex-1 text-sm font-mono"
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
    </div>
  )
}
