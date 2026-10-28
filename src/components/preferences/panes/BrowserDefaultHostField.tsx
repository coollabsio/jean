import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type FC,
} from 'react'
import { Loader2 } from '@/components/icons/reicon'
import { Input } from '@/components/ui/input'
import { normalizeBrowserDefaultHost } from '@/components/browser/default-tab-url'
import { usePatchPreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import { toast } from 'sonner'
import { InlineField } from '../InlineField'

export function isBrowserDefaultHostSavePending(
  isPending: boolean,
  variables: Partial<AppPreferences> | undefined | null
): boolean {
  return (
    isPending &&
    variables != null &&
    Object.hasOwn(variables, 'browser_default_host')
  )
}

/**
 * Server-wide preview hostname. Own mutation instance so other General saves
 * do not spin this field.
 */
export const BrowserDefaultHostField: FC<{
  preferences: AppPreferences | undefined
}> = ({ preferences }) => {
  const patchPreferences = usePatchPreferences()
  const saved = preferences?.browser_default_host ?? ''
  const [localValue, setLocalValue] = useState(saved)
  const [seenSaved, setSeenSaved] = useState(saved)
  if (saved !== seenSaved) {
    setSeenSaved(saved)
    setLocalValue(saved)
  }

  const hasChanges = localValue !== saved
  const isSaving = isBrowserDefaultHostSavePending(
    patchPreferences.isPending,
    patchPreferences.variables
  )

  const handleSave = useCallback(() => {
    if (!preferences || !hasChanges) return
    const normalized = normalizeBrowserDefaultHost(localValue)
    if (!normalized.ok) {
      toast.error(normalized.error)
      return
    }
    patchPreferences.mutate({ browser_default_host: normalized.host })
  }, [preferences, hasChanges, patchPreferences, localValue])

  // Escape closes Settings without blurring the input; keep the typed value.
  const flushOnUnmount = useEffectEvent(handleSave)
  useEffect(() => () => flushOnUnmount(), [])

  return (
    <InlineField
      label="Default preview hostname"
      description="Used when a jean.json port has no host. Blank means localhost."
      help="Applies to new browser tabs and Open port buttons for every client on this server, including remote sessions."
    >
      <div className="flex items-center gap-2">
        <Input
          id="browser-default-host"
          aria-label="Default preview hostname"
          className="w-full font-mono text-base sm:w-64 md:text-sm"
          placeholder="localhost"
          value={localValue}
          onChange={event => setLocalValue(event.target.value)}
          onBlur={handleSave}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {isSaving && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
    </InlineField>
  )
}
