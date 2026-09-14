import React from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { SettingsSection } from '../SettingsSection'

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-56 sm:shrink-0 lg:w-72">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
    </div>
    {children}
  </div>
)

export const ExperimentalPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
        <p className="text-sm text-muted-foreground">
          These features are experimental and may change or be removed in future
          versions. Use at your own risk.
        </p>
      </div>

      <SettingsSection
        title="Developer Tools"
        anchorId="pref-experimental-section-developer-tools"
      >
        <InlineField
          label="Debug mode"
          description="Show session debug panel with file paths, run logs, and token usage"
        >
          <Switch
            checked={preferences?.debug_mode_enabled ?? false}
            onCheckedChange={checked => {
              patchPreferences.mutate({ debug_mode_enabled: checked })
            }}
          />
        </InlineField>
      </SettingsSection>
    </div>
  )
}
