import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Loader2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineField } from '@/components/preferences/InlineField'

export interface PlaneSettingsValues {
  apiKey: string
  workspaceSlug: string
  baseUrl: string
}

const FIELDS = ['apiKey', 'workspaceSlug', 'baseUrl'] as const

type FieldHints = Partial<Record<keyof PlaneSettingsValues, ReactNode>>

interface PlaneSettingsFormProps {
  saved: PlaneSettingsValues
  /** Description under each field (e.g. the inherited global value) */
  hints?: FieldHints
  isSaving: boolean
  /**
   * Receives only the changed fields, trimmed; an empty string clears a
   * setting. Unchanged fields are left out so a redacted secret is not cleared.
   */
  onSave: (changes: Partial<PlaneSettingsValues>) => Promise<unknown>
}

/** API key, workspace slug, and base URL fields for the Plane integration. */
export function PlaneSettingsForm({
  saved,
  hints,
  isSaving,
  onSave,
}: PlaneSettingsFormProps) {
  const [draft, setDraft] = useState<PlaneSettingsValues | null>(null)
  const [showKey, setShowKey] = useState(false)
  const values = draft ?? saved
  const changed =
    draft !== null && FIELDS.some(key => draft[key] !== saved[key])

  const setField = (key: keyof PlaneSettingsValues, value: string) =>
    setDraft({ ...values, [key]: value })

  const handleSave = async () => {
    const changes: Partial<PlaneSettingsValues> = {}
    for (const key of FIELDS) {
      const value = values[key].trim()
      if (value !== saved[key]) changes[key] = value
    }
    if (changes.baseUrl && !/^https?:\/\/[^/\s]+/i.test(changes.baseUrl)) {
      toast.error('Plane base URL must start with http:// or https://')
      return
    }
    try {
      await onSave(changes)
      setDraft(null)
    } catch {
      // The mutation shows the error; keep the draft so the user can fix it.
    }
  }

  return (
    <>
      <InlineField
        layout="stacked"
        label="API Key"
        description={
          hints?.apiKey ?? (
            <>
              Create one in Plane under Profile settings &rarr; Personal Access
              Tokens. See the{' '}
              <a
                href="https://developers.plane.so/api-reference/introduction"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                Plane API docs
              </a>
              .
            </>
          )
        }
      >
        <div className="flex items-center gap-2">
          <Input
            type={showKey ? 'text' : 'password'}
            placeholder="plane_api_..."
            aria-label="Plane API key"
            value={values.apiKey}
            onChange={e => setField('apiKey', e.target.value)}
            className="flex-1 text-base md:text-sm font-mono"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? 'Hide' : 'Show'}
          </Button>
        </div>
      </InlineField>
      <InlineField
        layout="stacked"
        label="Workspace Slug"
        description={
          hints?.workspaceSlug ??
          'The part after the host in your Plane URL, e.g. "acme" in app.plane.so/acme.'
        }
      >
        <Input
          placeholder="acme"
          aria-label="Plane workspace slug"
          value={values.workspaceSlug}
          onChange={e => setField('workspaceSlug', e.target.value)}
          className="text-base md:text-sm font-mono"
        />
      </InlineField>
      <InlineField
        layout="stacked"
        label="Base URL"
        description={
          hints?.baseUrl ??
          'Leave empty for Plane Cloud (https://api.plane.so). For self-hosted Plane, enter your Plane URL.'
        }
      >
        <Input
          placeholder="https://api.plane.so"
          aria-label="Plane base URL"
          value={values.baseUrl}
          onChange={e => setField('baseUrl', e.target.value)}
          className="text-base md:text-sm font-mono"
        />
      </InlineField>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={!changed || isSaving}
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </>
  )
}
