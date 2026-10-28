import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type FC,
} from 'react'
import { Loader2 } from '@/components/icons/reicon'
import { Input } from '@/components/ui/input'
import { usePatchPreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import { InlineField } from '../InlineField'

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
// do not show this field's spinner during unrelated saves (#505).
export const AiLanguageField: FC<{
  preferences: AppPreferences | undefined
}> = ({ preferences }) => {
  const patchPreferences = usePatchPreferences()
  const saved = preferences?.ai_language ?? ''
  const [localValue, setLocalValue] = useState(saved)
  const [seenSaved, setSeenSaved] = useState(saved)
  if (saved !== seenSaved) {
    setSeenSaved(saved)
    setLocalValue(saved)
  }

  const hasChanges = localValue !== saved
  const isSaving = isAiLanguageSavePending(
    patchPreferences.isPending,
    patchPreferences.variables
  )

  const handleSave = useCallback(() => {
    if (!preferences || !hasChanges) return
    patchPreferences.mutate({ ai_language: localValue })
  }, [preferences, hasChanges, patchPreferences, localValue])

  // Escape closes Settings without blurring the input; keep the typed value.
  const flushOnUnmount = useEffectEvent(handleSave)
  useEffect(() => () => flushOnUnmount(), [])

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
          onBlur={handleSave}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        {isSaving && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
    </InlineField>
  )
}
