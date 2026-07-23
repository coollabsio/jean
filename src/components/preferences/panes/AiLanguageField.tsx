import { useCallback, useState, type FC } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { usePatchPreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'

const InlineField: FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="settings-inline-field flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-56 sm:shrink-0 lg:w-72">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground break-words">
          {description}
        </div>
      )}
    </div>
    {children}
  </div>
)

/** True only while this field's own ai_language patch is in flight. */
export function isAiLanguageSavePending(
  isPending: boolean,
  variables: Partial<AppPreferences> | undefined | null
): boolean {
  return (
    isPending && variables != null && Object.hasOwn(variables, 'ai_language')
  )
}

// Own mutation instance so model-default patches (and other GeneralPane saves)
// do not put this Save button into a shared isPending loading state (#505).
export const AiLanguageField: FC<{
  preferences: AppPreferences | undefined
}> = ({ preferences }) => {
  const patchPreferences = usePatchPreferences()
  const [localValue, setLocalValue] = useState(preferences?.ai_language ?? '')

  const hasChanges = localValue !== (preferences?.ai_language ?? '')
  const isSaving = isAiLanguageSavePending(
    patchPreferences.isPending,
    patchPreferences.variables
  )

  const handleSave = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({ ai_language: localValue })
  }, [preferences, patchPreferences, localValue])

  return (
    <InlineField
      label="AI Language"
      description="Language for AI responses (e.g. French, 日本語)"
    >
      <div className="flex items-center gap-2">
        <Input
          className="w-full sm:w-40"
          placeholder="Default"
          value={localValue}
          onChange={e => setLocalValue(e.target.value)}
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </InlineField>
  )
}
