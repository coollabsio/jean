import { useCallback, useState, type FC } from 'react'
import { Loader2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { normalizeBrowserDefaultHost } from '@/components/browser/default-tab-url'
import { usePatchPreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import { toast } from 'sonner'

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
 * do not spin this button.
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
    if (!preferences) return
    const normalized = normalizeBrowserDefaultHost(localValue)
    if (!normalized.ok) {
      toast.error(normalized.error)
      return
    }
    patchPreferences.mutate({ browser_default_host: normalized.host })
  }, [preferences, patchPreferences, localValue])

  return (
    <InlineField
      label="Default preview hostname"
      description="Hostname for new browser tabs and Open port buttons when a jean.json port has no host. Every client on this server uses it, including remote sessions. Leave blank for localhost."
    >
      <div className="flex items-center gap-2">
        <Input
          id="browser-default-host"
          aria-label="Default preview hostname"
          className="w-full font-mono text-base sm:w-64 md:text-sm"
          placeholder="localhost"
          value={localValue}
          onChange={event => setLocalValue(event.target.value)}
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges || isSaving || !preferences}
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </InlineField>
  )
}
