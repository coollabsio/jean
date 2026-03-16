import React from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { modelOptions, type ClaudeModel } from '@/types/preferences'

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
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-96 sm:shrink-0">
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

      <SettingsSection title="AI Behavior">
        <div className="space-y-4">
          <InlineField
            label="Parallel execution prompting"
            description="Add system prompt encouraging sub-agent parallelization for faster task execution"
          >
            <Switch
              checked={preferences?.parallel_execution_prompt_enabled ?? false}
              onCheckedChange={checked => {
                patchPreferences.mutate({ parallel_execution_prompt_enabled: checked })
              }}
            />
          </InlineField>

          <InlineField
            label="Automatic session recap"
            description="Auto-generate AI summary when returning to unfocused sessions. Press R on canvas to generate on-demand."
          >
            <Switch
              checked={preferences?.session_recap_enabled ?? false}
              onCheckedChange={checked => {
                patchPreferences.mutate({ session_recap_enabled: checked })
              }}
            />
          </InlineField>

          <InlineField
            label="Recap model"
            description="Claude model for automatic and on-demand session recaps"
          >
            <Select
              value={preferences?.magic_prompt_models.session_recap_model ?? 'haiku'}
              onValueChange={(value: ClaudeModel) => {
                if (preferences) {
                  patchPreferences.mutate({
                    magic_prompt_models: {
                      ...preferences.magic_prompt_models,
                      session_recap_model: value,
                    },
                  })
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Developer Tools">
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
