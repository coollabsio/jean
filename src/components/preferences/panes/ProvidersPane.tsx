import React, { useState } from 'react'
import { invoke } from '@/lib/transport'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  type CustomCliProfile,
  PREDEFINED_CLI_PROFILES,
} from '@/types/preferences'

const SettingsSection: React.FC<{
  title: string
  description?: string
  children: React.ReactNode
}> = ({ title, description, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

export const ProvidersPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  const profiles = preferences?.custom_cli_profiles ?? []

  const handleSaveProfiles = (updated: CustomCliProfile[]) => {
    patchPreferences.mutate({ custom_cli_profiles: updated })
  }

  const defaultProvider = preferences?.default_provider ?? null

  const handleDefaultProviderChange = (value: string) => {
    patchPreferences.mutate({
      default_provider: value === 'default' ? null : value,
    })
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Claude CLI"
        description="Custom settings profiles for the Claude CLI. Each profile can override the API endpoint, authentication, and model routing."
      >
        <CliProfilesEditor profiles={profiles} onSave={handleSaveProfiles} />

        {profiles.length > 0 && (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Default Provider</p>
              <p className="text-xs text-muted-foreground">
                Provider used for new sessions
              </p>
            </div>
            <Select
              value={defaultProvider ?? 'default'}
              onValueChange={handleDefaultProviderChange}
            >
              <SelectTrigger className="w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Anthropic</SelectItem>
                {profiles.map(p => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

/** CLI Profiles editor */
const CliProfilesEditor: React.FC<{
  profiles: CustomCliProfile[]
  onSave: (profiles: CustomCliProfile[]) => void
}> = ({ profiles, onSave }) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [editName, setEditName] = useState('')
  const [editJson, setEditJson] = useState('')
  const [editSupportsThinking, setEditSupportsThinking] = useState(true)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const existingNames = new Set(profiles.map(p => p.name))
  const availableTemplates = PREDEFINED_CLI_PROFILES.filter(
    t => !existingNames.has(t.name)
  )

  const validateAndSave = async () => {
    const name = editName.trim()
    if (!name) {
      setJsonError('Name is required')
      return
    }
    try {
      JSON.parse(editJson)
    } catch {
      setJsonError('Invalid JSON')
      return
    }
    setJsonError(null)

    // Write settings to standalone file in ~/.claude/
    try {
      await invoke<string>('save_cli_profile', {
        name,
        settingsJson: editJson,
      })
    } catch (e) {
      setJsonError(`Failed to save: ${e}`)
      return
    }

    const newProfile: CustomCliProfile = {
      name,
      settings_json: editJson,
      supports_thinking: editSupportsThinking,
    }
    if (editingIndex !== null) {
      const updated = [...profiles]
      updated[editingIndex] = newProfile
      onSave(updated)
      setEditingIndex(null)
    } else {
      onSave([...profiles, newProfile])
      setIsAdding(false)
    }
    setEditName('')
    setEditJson('')
  }

  const startEdit = (index: number) => {
    const profile = profiles[index]
    if (!profile) return
    setEditingIndex(index)
    setEditName(profile.name)
    setEditJson(profile.settings_json)
    const predefined = PREDEFINED_CLI_PROFILES.find(
      p => p.name === profile.name
    )
    setEditSupportsThinking(
      (profile.supports_thinking ?? predefined?.supports_thinking) !== false
    )
    setJsonError(null)
    setIsAdding(false)
  }

  const startAdd = (template?: CustomCliProfile) => {
    setIsAdding(true)
    setEditName(template?.name ?? '')
    setEditJson(template?.settings_json ?? '{\n  "env": {\n    \n  }\n}')
    setEditSupportsThinking(template?.supports_thinking !== false)
    setJsonError(null)
    setEditingIndex(null)
  }

  const cancelEdit = () => {
    setEditingIndex(null)
    setIsAdding(false)
    setEditName('')
    setEditJson('')
    setJsonError(null)
  }

  const deleteProfile = async (index: number) => {
    const profile = profiles[index]
    if (profile) {
      try {
        await invoke('delete_cli_profile', { name: profile.name })
      } catch (e) {
        console.error('Failed to delete CLI profile file:', e)
      }
    }
    onSave(profiles.filter((_, i) => i !== index))
    if (editingIndex === index) cancelEdit()
  }

  return (
    <div className="space-y-3">
      {/* Existing profiles */}
      {profiles.map((profile, index) => (
        <div
          key={profile.name}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
        >
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium">{profile.name}</span>
            {profile.file_path && (
              <p className="text-xs text-muted-foreground truncate">
                {profile.file_path}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => startEdit(index)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => deleteProfile(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {/* Edit/Add form */}
      {(isAdding || editingIndex !== null) && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Input
            placeholder="Profile name"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            className="h-8"
          />
          <Textarea
            placeholder='{"env": {"ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..."}}'
            value={editJson}
            onChange={e => {
              setEditJson(e.target.value)
              setJsonError(null)
            }}
            className="min-h-[120px] font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Switch
              checked={editSupportsThinking}
              onCheckedChange={setEditSupportsThinking}
            />
            <p className="text-sm text-muted-foreground">
              Supports thinking/effort levels
            </p>
          </div>
          {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={validateAndSave}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Add buttons */}
      {!isAdding && editingIndex === null && (
        <div className="flex flex-wrap gap-2">
          {availableTemplates.map(template => (
            <Button
              key={template.name}
              variant="outline"
              size="sm"
              onClick={() => startAdd(template)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {template.name}
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={() => startAdd()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Custom
          </Button>
        </div>
      )}
    </div>
  )
}
