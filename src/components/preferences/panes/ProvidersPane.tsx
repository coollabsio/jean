import React, { useState } from 'react'
import { invoke } from '@/lib/transport'
import { Pencil, Plus, Trash2 } from 'lucide-react'
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
  type CodexProviderProfile,
  type CustomCliProfile,
  type PiProviderProfile,
  PREDEFINED_CLI_PROFILES,
  PREDEFINED_CODEX_PROVIDERS,
  PREDEFINED_PI_PROVIDERS,
} from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

export const ProvidersPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  const profiles = preferences?.custom_cli_profiles ?? []
  const codexProviders = preferences?.custom_codex_providers ?? []
  const piProviders = preferences?.custom_pi_providers ?? []

  const handleSaveProfiles = (updated: CustomCliProfile[]) => {
    patchPreferences.mutate({ custom_cli_profiles: updated })
  }

  const handleSaveCodexProviders = (updated: CodexProviderProfile[]) => {
    patchPreferences.mutate({ custom_codex_providers: updated })
  }

  const handleSavePiProviders = (updated: PiProviderProfile[]) => {
    patchPreferences.mutate({ custom_pi_providers: updated })
  }

  const defaultProvider = preferences?.default_provider ?? null
  const defaultCodexProvider = preferences?.default_codex_provider ?? null

  const handleDefaultProviderChange = (value: string) => {
    patchPreferences.mutate({
      default_provider: value === 'default' ? null : value,
    })
  }

  const handleDefaultCodexProviderChange = (value: string) => {
    patchPreferences.mutate({
      default_codex_provider: value === 'default' ? null : value,
    })
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Claude CLI"
        description="Custom settings profiles for the Claude CLI. Each profile can override the API endpoint, authentication, and model routing via Anthropic-compatible env vars. Stored under ~/.claude/settings.jean.*.json."
        anchorId="pref-providers-section-claude-cli"
      >
        <CliProfilesEditor profiles={profiles} onSave={handleSaveProfiles} />

        {profiles.length > 0 && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Default Provider</p>
              <p className="text-xs text-muted-foreground">
                Provider used for new Claude sessions
              </p>
            </div>
            <Select
              value={defaultProvider ?? 'default'}
              onValueChange={handleDefaultProviderChange}
            >
              <SelectTrigger className="w-full sm:w-80">
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

      <SettingsSection
        title="Codex"
        description="Custom model_provider profiles for Codex CLI (e.g. OpenRouter). Injected per session via app-server config — your default ~/.codex/config.toml is not rewritten. Put the API key in the named environment variable."
        anchorId="pref-providers-section-codex"
      >
        <CodexProvidersEditor
          providers={codexProviders}
          onSave={handleSaveCodexProviders}
        />

        {codexProviders.length > 0 && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Default Codex Provider</p>
              <p className="text-xs text-muted-foreground">
                Provider used for new Codex sessions (null keeps ChatGPT / OpenAI
                default)
              </p>
            </div>
            <Select
              value={defaultCodexProvider ?? 'default'}
              onValueChange={handleDefaultCodexProviderChange}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default (OpenAI / ChatGPT)</SelectItem>
                {codexProviders.map(p => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="PI"
        description="Custom PI providers merged into ~/.pi/agent/models.json. Credentials stay in env vars or PI auth.json (multi-provider). After saving, models appear in the PI model picker as provider/model."
        anchorId="pref-providers-section-pi"
      >
        <PiProvidersEditor
          providers={piProviders}
          onSave={handleSavePiProviders}
        />
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
            className="min-h-[120px] font-mono text-base md:text-xs"
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

const CodexProvidersEditor: React.FC<{
  providers: CodexProviderProfile[]
  onSave: (providers: CodexProviderProfile[]) => void
}> = ({ providers, onSave }) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [editName, setEditName] = useState('')
  const [editProviderId, setEditProviderId] = useState('')
  const [editBaseUrl, setEditBaseUrl] = useState('')
  const [editEnvKey, setEditEnvKey] = useState('')
  const [editWireApi, setEditWireApi] = useState<'chat' | 'responses' | ''>('')
  const [error, setError] = useState<string | null>(null)

  const existingNames = new Set(providers.map(p => p.name))
  const availableTemplates = PREDEFINED_CODEX_PROVIDERS.filter(
    t => !existingNames.has(t.name)
  )

  const resetForm = () => {
    setEditName('')
    setEditProviderId('')
    setEditBaseUrl('')
    setEditEnvKey('')
    setEditWireApi('')
    setError(null)
  }

  const cancelEdit = () => {
    setEditingIndex(null)
    setIsAdding(false)
    resetForm()
  }

  const startEdit = (index: number) => {
    const p = providers[index]
    if (!p) return
    setEditingIndex(index)
    setIsAdding(false)
    setEditName(p.name)
    setEditProviderId(p.provider_id)
    setEditBaseUrl(p.base_url)
    setEditEnvKey(p.env_key)
    setEditWireApi(p.wire_api ?? '')
    setError(null)
  }

  const startAdd = (template?: CodexProviderProfile) => {
    setIsAdding(true)
    setEditingIndex(null)
    setEditName(template?.name ?? '')
    setEditProviderId(template?.provider_id ?? '')
    setEditBaseUrl(template?.base_url ?? '')
    setEditEnvKey(template?.env_key ?? '')
    setEditWireApi(template?.wire_api ?? '')
    setError(null)
  }

  const validateAndSave = () => {
    const name = editName.trim()
    const providerId = editProviderId.trim()
    const baseUrl = editBaseUrl.trim()
    const envKey = editEnvKey.trim()
    if (!name) {
      setError('Name is required')
      return
    }
    if (!providerId) {
      setError('Provider ID is required (e.g. openrouter)')
      return
    }
    if (!baseUrl) {
      setError('Base URL is required')
      return
    }
    if (!envKey) {
      setError('Env key is required (API key lives in that environment variable)')
      return
    }
    const duplicate = providers.some(
      (p, i) => p.name === name && i !== editingIndex
    )
    if (duplicate) {
      setError('A provider with this name already exists')
      return
    }

    const profile: CodexProviderProfile = {
      name,
      provider_id: providerId,
      base_url: baseUrl,
      env_key: envKey,
      ...(editWireApi ? { wire_api: editWireApi } : {}),
    }

    if (editingIndex !== null) {
      const updated = [...providers]
      updated[editingIndex] = profile
      onSave(updated)
      setEditingIndex(null)
    } else {
      onSave([...providers, profile])
      setIsAdding(false)
    }
    resetForm()
  }

  const deleteProvider = (index: number) => {
    onSave(providers.filter((_, i) => i !== index))
    if (editingIndex === index) cancelEdit()
  }

  return (
    <div className="space-y-3">
      {providers.map((provider, index) => (
        <div
          key={provider.name}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
        >
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium">{provider.name}</span>
            <p className="text-xs text-muted-foreground truncate">
              {provider.provider_id} · {provider.base_url} · env:{' '}
              {provider.env_key}
            </p>
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
            onClick={() => deleteProvider(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {(isAdding || editingIndex !== null) && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Input
            placeholder="Display name (e.g. OpenRouter)"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            className="h-8"
          />
          <Input
            placeholder="Provider ID (e.g. openrouter)"
            value={editProviderId}
            onChange={e => setEditProviderId(e.target.value)}
            className="h-8 font-mono text-sm"
          />
          <Input
            placeholder="Base URL (e.g. https://openrouter.ai/api/v1)"
            value={editBaseUrl}
            onChange={e => setEditBaseUrl(e.target.value)}
            className="h-8 font-mono text-sm"
          />
          <Input
            placeholder="Env key (e.g. OPENROUTER_API_KEY)"
            value={editEnvKey}
            onChange={e => setEditEnvKey(e.target.value)}
            className="h-8 font-mono text-sm"
          />
          <Select
            value={editWireApi || 'none'}
            onValueChange={v =>
              setEditWireApi(v === 'none' ? '' : (v as 'chat' | 'responses'))
            }
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue placeholder="Wire API (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Wire API: default</SelectItem>
              <SelectItem value="responses">responses</SelectItem>
              <SelectItem value="chat">chat</SelectItem>
            </SelectContent>
          </Select>
          {error && <p className="text-xs text-destructive">{error}</p>}
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

const PiProvidersEditor: React.FC<{
  providers: PiProviderProfile[]
  onSave: (providers: PiProviderProfile[]) => void
}> = ({ providers, onSave }) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [editName, setEditName] = useState('')
  const [editBaseUrl, setEditBaseUrl] = useState('')
  const [editApi, setEditApi] =
    useState<PiProviderProfile['api']>('openai-completions')
  const [editApiKeyEnv, setEditApiKeyEnv] = useState('')
  const [editModels, setEditModels] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const existingNames = new Set(providers.map(p => p.name))
  const availableTemplates = PREDEFINED_PI_PROVIDERS.filter(
    t => !existingNames.has(t.name)
  )

  const resetForm = () => {
    setEditName('')
    setEditBaseUrl('')
    setEditApi('openai-completions')
    setEditApiKeyEnv('')
    setEditModels('')
    setError(null)
  }

  const cancelEdit = () => {
    setEditingIndex(null)
    setIsAdding(false)
    resetForm()
  }

  const startEdit = (index: number) => {
    const p = providers[index]
    if (!p) return
    setEditingIndex(index)
    setIsAdding(false)
    setEditName(p.name)
    setEditBaseUrl(p.base_url)
    setEditApi(p.api)
    setEditApiKeyEnv(p.api_key_env ?? '')
    setEditModels(
      p.models.map(m => (m.name ? `${m.id}|${m.name}` : m.id)).join('\n')
    )
    setError(null)
  }

  const startAdd = (template?: PiProviderProfile) => {
    setIsAdding(true)
    setEditingIndex(null)
    setEditName(template?.name ?? '')
    setEditBaseUrl(template?.base_url ?? '')
    setEditApi(template?.api ?? 'openai-completions')
    setEditApiKeyEnv(template?.api_key_env ?? '')
    setEditModels(
      template?.models
        .map(m => (m.name ? `${m.id}|${m.name}` : m.id))
        .join('\n') ?? ''
    )
    setError(null)
  }

  const parseModels = (): PiProviderProfile['models'] | null => {
    const lines = editModels
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return null
    return lines.map(line => {
      const [id, name] = line.split('|').map(s => s.trim())
      return name ? { id: id ?? line, name } : { id: id ?? line }
    })
  }

  const validateAndSave = async () => {
    const name = editName.trim()
    const baseUrl = editBaseUrl.trim()
    if (!name) {
      setError('Provider name is required (no spaces/slashes)')
      return
    }
    if (name.includes('/') || name.includes(' ')) {
      setError('Provider name must be a single token (no spaces or slashes)')
      return
    }
    if (!baseUrl) {
      setError('Base URL is required')
      return
    }
    const models = parseModels()
    if (!models) {
      setError('At least one model id is required (one per line, optional id|name)')
      return
    }
    const duplicate = providers.some(
      (p, i) => p.name === name && i !== editingIndex
    )
    if (duplicate) {
      setError('A provider with this name already exists')
      return
    }

    const profile: PiProviderProfile = {
      name,
      base_url: baseUrl,
      api: editApi,
      ...(editApiKeyEnv.trim()
        ? { api_key_env: editApiKeyEnv.trim() }
        : {}),
      models,
    }

    setSaving(true)
    setError(null)
    try {
      await invoke('upsert_pi_provider', { profile })
    } catch (e) {
      setError(`Failed to write models.json: ${e}`)
      setSaving(false)
      return
    }
    setSaving(false)

    if (editingIndex !== null) {
      const updated = [...providers]
      updated[editingIndex] = profile
      onSave(updated)
      setEditingIndex(null)
    } else {
      onSave([...providers, profile])
      setIsAdding(false)
    }
    resetForm()
  }

  const deleteProvider = async (index: number) => {
    const provider = providers[index]
    if (provider) {
      try {
        await invoke('delete_pi_provider', { name: provider.name })
      } catch (e) {
        console.error('Failed to delete PI provider from models.json:', e)
      }
    }
    onSave(providers.filter((_, i) => i !== index))
    if (editingIndex === index) cancelEdit()
  }

  return (
    <div className="space-y-3">
      {providers.map((provider, index) => (
        <div
          key={provider.name}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
        >
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium">{provider.name}</span>
            <p className="text-xs text-muted-foreground truncate">
              {provider.base_url} · {provider.models.length} model
              {provider.models.length === 1 ? '' : 's'}
              {provider.api_key_env ? ` · $${provider.api_key_env}` : ''}
            </p>
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
            onClick={() => deleteProvider(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {(isAdding || editingIndex !== null) && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Input
            placeholder="Provider id (e.g. openrouter)"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            className="h-8 font-mono text-sm"
          />
          <Input
            placeholder="Base URL"
            value={editBaseUrl}
            onChange={e => setEditBaseUrl(e.target.value)}
            className="h-8 font-mono text-sm"
          />
          <Select
            value={editApi}
            onValueChange={v => setEditApi(v as PiProviderProfile['api'])}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai-completions">
                openai-completions
              </SelectItem>
              <SelectItem value="openai-responses">openai-responses</SelectItem>
              <SelectItem value="anthropic-messages">
                anthropic-messages
              </SelectItem>
              <SelectItem value="google-generative-ai">
                google-generative-ai
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="API key env (optional, e.g. OPENROUTER_API_KEY)"
            value={editApiKeyEnv}
            onChange={e => setEditApiKeyEnv(e.target.value)}
            className="h-8 font-mono text-sm"
          />
          <Textarea
            placeholder={
              'Models (one per line)\nid or id|Display name\ne.g. anthropic/claude-sonnet-4|Sonnet 4'
            }
            value={editModels}
            onChange={e => setEditModels(e.target.value)}
            className="min-h-[100px] font-mono text-base md:text-xs"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={validateAndSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      )}

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
