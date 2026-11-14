import React, { useState } from 'react'
import { invoke } from '@/lib/transport'
import { Pencil, Plus, Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  type CodexProviderProfile,
  type CustomCliProfile,
  type PiProviderProfile,
  type QwenCloudBillingMode,
  PREDEFINED_CLI_PROFILES,
  PREDEFINED_CODEX_PROVIDERS,
  PREDEFINED_PI_PROVIDERS,
  isClaudeModelId,
  QWENCLOUD_BILLING_MODE_LABELS,
  QWENCLOUD_ENDPOINTS,
  qwenCloudApiKeyEnv,
  qwenCloudOpenAiBaseUrl,
  qwenCloudRegionFromValue,
  withQwenCloudRegion,
} from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'
import { InlineField } from '../InlineField'

/**
 * Escape hatch for Claude models released after this build. Jean cannot
 * discover them from the Claude CLI (it exposes no model list, and OAuth
 * tokens cannot call /v1/models), so the user can add the id here until the
 * bundled list or the CDN catalog catches up.
 */
const CustomClaudeModelsEditor: React.FC<{
  models: string[]
  onSave: (models: string[]) => void
}> = ({ models, onSave }) => {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const startEdit = () => {
    setDraft(models.join('\n'))
    setError(null)
    setIsEditing(true)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setError(null)
  }

  const save = () => {
    const lines = draft
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    const invalid = lines.find(line => !isClaudeModelId(line))
    if (invalid) {
      setError(`Not a Claude model id: ${invalid}`)
      return
    }
    onSave([...new Set(lines)])
    setIsEditing(false)
    setError(null)
  }

  return (
    <div className="space-y-1">
      {models.map(model => (
        <div key={model} className="flex items-center gap-2 py-1">
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            {model}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onSave(models.filter(item => item !== model))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            placeholder={'One model id per line\ne.g. claude-fable-5-2'}
            value={draft}
            onChange={e => {
              setDraft(e.target.value)
              setError(null)
            }}
            className="min-h-[80px] font-mono text-base md:text-xs"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={startEdit}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add model id
        </Button>
      )}
    </div>
  )
}

const QWENCLOUD_MODE_ORDER: QwenCloudBillingMode[] = [
  'pay-as-you-go',
  'token-plan',
]

/**
 * QwenCloud keys are region-scoped AND billing-mode-specific. Show this picker
 * whenever a provider points at a QwenCloud endpoint: it rewrites the base URL
 * (or the Claude CLI settings JSON) and the caller also switches the API key
 * env var when the billing mode changes.
 */
const QwenCloudEndpointSelect: React.FC<{
  value: string
  onValueChange: (endpointId: string) => void
}> = ({ value, onValueChange }) => (
  <div className="space-y-1">
    <p className="text-xs text-muted-foreground">
      QwenCloud region / billing mode. Pay-as-you-go and Token Plan use
      different keys and are not interchangeable.
    </p>
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="w-full sm:w-80">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {QWENCLOUD_MODE_ORDER.map(mode => (
          <SelectGroup key={mode}>
            <SelectLabel>{QWENCLOUD_BILLING_MODE_LABELS[mode]}</SelectLabel>
            {QWENCLOUD_ENDPOINTS.filter(endpoint => endpoint.mode === mode).map(
              endpoint => (
                <SelectItem key={endpoint.id} value={endpoint.id}>
                  {endpoint.label}
                </SelectItem>
              )
            )}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  </div>
)

export const ClaudeProvidersSection: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const profiles = preferences?.custom_cli_profiles ?? []
  const customModels = preferences?.custom_claude_models ?? []
  const defaultProvider = preferences?.default_provider ?? null

  return (
    <SettingsSection
      title="Providers"
      description="Custom Claude CLI settings profiles (Anthropic-compatible endpoints)."
      anchorId="pref-providers-section-claude-cli"
    >
      <CliProfilesEditor
        profiles={profiles}
        onSave={updated =>
          patchPreferences.mutate({ custom_cli_profiles: updated })
        }
      />

      <InlineField
        label="Custom model IDs"
        description="Claude models released after this Jean build. They appear in the Claude model picker."
      >
        <CustomClaudeModelsEditor
          models={customModels}
          onSave={updated =>
            patchPreferences.mutate({ custom_claude_models: updated })
          }
        />
      </InlineField>

      {profiles.length > 0 && (
        <InlineField
          label="Default provider"
          description="Used for new Claude sessions"
        >
          <Select
            value={defaultProvider ?? 'default'}
            onValueChange={value =>
              patchPreferences.mutate({
                default_provider: value === 'default' ? null : value,
              })
            }
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
        </InlineField>
      )}
    </SettingsSection>
  )
}

export const CodexProvidersSection: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const codexProviders = preferences?.custom_codex_providers ?? []
  const defaultCodexProvider = preferences?.default_codex_provider ?? null

  return (
    <SettingsSection
      title="Providers"
      description="Custom model providers (for example OpenRouter), injected per session. Your ~/.codex/config.toml is not rewritten."
      anchorId="pref-providers-section-codex"
    >
      <CodexProvidersEditor
        providers={codexProviders}
        onSave={updated =>
          patchPreferences.mutate({ custom_codex_providers: updated })
        }
      />

      {codexProviders.length > 0 && (
        <InlineField
          label="Default provider"
          description="Used for new Codex sessions"
        >
          <Select
            value={defaultCodexProvider ?? 'default'}
            onValueChange={value =>
              patchPreferences.mutate({
                default_codex_provider: value === 'default' ? null : value,
              })
            }
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">OpenAI / ChatGPT</SelectItem>
              {codexProviders.map(p => (
                <SelectItem key={p.name} value={p.name}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InlineField>
      )}
    </SettingsSection>
  )
}

export const PiProvidersSection: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const piProviders = preferences?.custom_pi_providers ?? []

  return (
    <SettingsSection
      title="Providers"
      description="Custom providers merged into ~/.pi/agent/models.json. Their models appear in the PI picker as provider/model."
      anchorId="pref-providers-section-pi"
    >
      <PiProvidersEditor
        providers={piProviders}
        onSave={updated =>
          patchPreferences.mutate({ custom_pi_providers: updated })
        }
      />
    </SettingsSection>
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
    <div className="space-y-1">
      {profiles.map((profile, index) => (
        <div key={profile.name} className="flex items-center gap-2 py-1">
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
            size="icon-sm"
            onClick={() => startEdit(index)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            onClick={() => deleteProfile(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {(isAdding || editingIndex !== null) && (
        <div className="space-y-2">
          <Input
            placeholder="Profile name"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            className="h-8"
          />
          {qwenCloudRegionFromValue(editJson) && (
            <QwenCloudEndpointSelect
              value={qwenCloudRegionFromValue(editJson) ?? ''}
              onValueChange={endpointId =>
                setEditJson(current => withQwenCloudRegion(current, endpointId))
              }
            />
          )}
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

/** Label + optional hint around a form control, so every provider field is
 *  identifiable without relying on its placeholder. */
const ProviderField: React.FC<{
  label: string
  hint?: string
  children: React.ReactNode
}> = ({ label, hint, children }) => (
  <div className="space-y-1.5">
    <div className="text-xs font-medium text-foreground">{label}</div>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
)

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
      setError(
        'Env key is required (API key lives in that environment variable)'
      )
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
    <div className="space-y-1">
      {providers.map((provider, index) => (
        <div key={provider.name} className="flex items-center gap-2 py-1">
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium">{provider.name}</span>
            <p className="text-xs text-muted-foreground truncate">
              {provider.provider_id} · {provider.base_url} · env:{' '}
              {provider.env_key}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => startEdit(index)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            onClick={() => deleteProvider(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {(isAdding || editingIndex !== null) && (
        <div className="space-y-3">
          <ProviderField
            label="Display name"
            hint="Shown in the provider picker."
          >
            <Input
              aria-label="Display name"
              placeholder="OpenRouter"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="h-8"
            />
          </ProviderField>
          <ProviderField
            label="Provider ID"
            hint="Used in model IDs as provider/model. Lowercase, no spaces."
          >
            <Input
              aria-label="Provider ID"
              placeholder="openrouter"
              value={editProviderId}
              onChange={e => setEditProviderId(e.target.value)}
              className="h-8 font-mono text-sm"
            />
          </ProviderField>
          <ProviderField
            label="Base URL"
            hint="OpenAI-compatible endpoint. Usually ends with /v1."
          >
            <Input
              aria-label="Base URL"
              placeholder="https://openrouter.ai/api/v1"
              value={editBaseUrl}
              onChange={e => setEditBaseUrl(e.target.value)}
              className="h-8 font-mono text-sm"
            />
          </ProviderField>
          {qwenCloudRegionFromValue(editBaseUrl) && (
            <ProviderField
              label="Endpoint"
              hint="Pay-as-you-go and Token Plan use different keys and cannot be mixed."
            >
              <QwenCloudEndpointSelect
                value={qwenCloudRegionFromValue(editBaseUrl) ?? ''}
                onValueChange={endpointId => {
                  setEditBaseUrl(qwenCloudOpenAiBaseUrl(endpointId))
                  setEditEnvKey(qwenCloudApiKeyEnv(endpointId))
                }}
              />
            </ProviderField>
          )}
          <ProviderField
            label="API key environment variable"
            hint="Jean reads the key from this variable at runtime; the key itself is not stored."
          >
            <Input
              aria-label="API key environment variable"
              placeholder="OPENROUTER_API_KEY"
              value={editEnvKey}
              onChange={e => setEditEnvKey(e.target.value)}
              className="h-8 font-mono text-sm"
            />
          </ProviderField>
          <ProviderField
            label="Wire API"
            hint="Leave on default unless the provider only speaks one protocol."
          >
            <Select
              value={editWireApi || 'none'}
              onValueChange={v =>
                setEditWireApi(v === 'none' ? '' : (v as 'chat' | 'responses'))
              }
            >
              <SelectTrigger aria-label="Wire API" className="w-full sm:w-80">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Default (auto)</SelectItem>
                <SelectItem value="responses">Responses API</SelectItem>
                <SelectItem value="chat">Chat Completions</SelectItem>
              </SelectContent>
            </Select>
          </ProviderField>
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
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchNotice, setFetchNotice] = useState<string | null>(null)
  const [qwenOnly, setQwenOnly] = useState(false)
  const [fetchedModelIds, setFetchedModelIds] = useState<string[] | null>(null)

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
    setFetchNotice(null)
    setFetchedModelIds(null)
  }

  const cancelEdit = () => {
    setEditingIndex(null)
    setIsAdding(false)
    resetForm()
  }

  /**
   * `/models` returns every model the key can reach on that endpoint, which
   * includes QwenCloud's third-party text models (DeepSeek, Kimi, GLM,
   * MiniMax) and may include non-chat models. `qwenOnly` narrows it to
   * Qwen-branded ids without an extra network call.
   */
  const applyFetchedModels = (ids: string[], onlyQwen: boolean): boolean => {
    const visible = onlyQwen
      ? ids.filter(id => id.toLowerCase().startsWith('qwen'))
      : ids
    if (visible.length === 0) return false
    setEditModels(visible.join('\n'))
    setFetchedModelIds(ids)
    setFetchNotice(
      onlyQwen
        ? `Loaded ${visible.length} Qwen models`
        : `Loaded ${visible.length} models from QwenCloud (Qwen + third-party)`
    )
    return true
  }

  /**
   * QwenCloud exposes `GET {base_url}/models`. The Rust side reads the API key
   * from its own environment, so no secret crosses the WebSocket transport.
   * Silent mode is a best-effort autofetch: failures keep the curated model
   * list instead of surfacing an error on first open.
   */
  const fetchModelsFromQwenCloud = async (
    baseUrlOverride?: string,
    apiKeyEnvOverride?: string,
    silent = false
  ) => {
    const baseUrl = (baseUrlOverride ?? editBaseUrl).trim()
    if (!qwenCloudRegionFromValue(baseUrl)) return
    setFetchingModels(true)
    setFetchNotice(null)
    if (!silent) setError(null)
    try {
      const ids = await invoke<string[]>('fetch_qwencloud_models', {
        baseUrl,
        apiKeyEnv: (apiKeyEnvOverride ?? editApiKeyEnv).trim() || undefined,
      })
      if (!applyFetchedModels(ids, qwenOnly)) {
        if (!silent) {
          setError(
            qwenOnly
              ? 'QwenCloud returned no Qwen-branded models'
              : 'QwenCloud returned no models'
          )
        }
        return
      }
    } catch (e) {
      if (!silent) {
        setError(
          `Could not fetch models: ${e}. Check the API key env var and region.`
        )
      } else {
        setFetchNotice(
          "Using the bundled model list - set the API key in Jean's environment to autofetch."
        )
      }
    } finally {
      setFetchingModels(false)
    }
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
    setFetchNotice(null)
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
    setFetchNotice(null)
    // Model availability differs per region, so refresh as soon as the
    // QwenCloud preset is picked. Failure is silent and keeps the fallback.
    if (template && qwenCloudRegionFromValue(template.base_url)) {
      void fetchModelsFromQwenCloud(
        template.base_url,
        template.api_key_env,
        true
      )
    }
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
      setError(
        'At least one model id is required (one per line, optional id|name)'
      )
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
      ...(editApiKeyEnv.trim() ? { api_key_env: editApiKeyEnv.trim() } : {}),
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
    <div className="space-y-1">
      {providers.map((provider, index) => (
        <div key={provider.name} className="flex items-center gap-2 py-1">
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
            size="icon-sm"
            onClick={() => startEdit(index)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            onClick={() => deleteProvider(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {(isAdding || editingIndex !== null) && (
        <div className="space-y-3">
          <ProviderField
            label="Provider ID"
            hint="Shown in the PI model picker as provider/model. Lowercase, no spaces."
          >
            <Input
              aria-label="Provider ID"
              placeholder="openrouter"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="h-8 font-mono text-sm"
            />
          </ProviderField>
          <ProviderField
            label="Base URL"
            hint="Endpoint of the provider's OpenAI-compatible API."
          >
            <Input
              aria-label="Base URL"
              placeholder="https://openrouter.ai/api/v1"
              value={editBaseUrl}
              onChange={e => setEditBaseUrl(e.target.value)}
              className="h-8 font-mono text-sm"
            />
          </ProviderField>
          {qwenCloudRegionFromValue(editBaseUrl) && (
            <ProviderField
              label="Endpoint"
              hint="Pay-as-you-go and Token Plan use different keys and cannot be mixed."
            >
              <QwenCloudEndpointSelect
                value={qwenCloudRegionFromValue(editBaseUrl) ?? ''}
                onValueChange={endpointId => {
                  const baseUrl = qwenCloudOpenAiBaseUrl(endpointId)
                  const keyEnv = qwenCloudApiKeyEnv(endpointId)
                  setEditBaseUrl(baseUrl)
                  setEditApiKeyEnv(keyEnv)
                  // Models differ by region AND by billing mode - refresh.
                  void fetchModelsFromQwenCloud(baseUrl, keyEnv, true)
                }}
              />
            </ProviderField>
          )}
          <ProviderField
            label="API type"
            hint="Match the protocol the endpoint exposes."
          >
            <Select
              value={editApi}
              onValueChange={v => setEditApi(v as PiProviderProfile['api'])}
            >
              <SelectTrigger aria-label="API type" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-completions">
                  OpenAI Chat Completions
                </SelectItem>
                <SelectItem value="openai-responses">
                  OpenAI Responses
                </SelectItem>
                <SelectItem value="anthropic-messages">
                  Anthropic Messages
                </SelectItem>
                <SelectItem value="google-generative-ai">
                  Google Generative AI
                </SelectItem>
              </SelectContent>
            </Select>
          </ProviderField>
          <ProviderField
            label="API key environment variable"
            hint="Optional. Jean reads the key from this variable at runtime."
          >
            <Input
              aria-label="API key environment variable"
              placeholder="OPENROUTER_API_KEY"
              value={editApiKeyEnv}
              onChange={e => setEditApiKeyEnv(e.target.value)}
              className="h-8 font-mono text-sm"
            />
          </ProviderField>
          {qwenCloudRegionFromValue(editBaseUrl) && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={fetchingModels || saving}
                  onClick={() => void fetchModelsFromQwenCloud()}
                >
                  {fetchingModels ? 'Fetching…' : 'Fetch models from QwenCloud'}
                </Button>
                {fetchNotice && (
                  <p className="text-xs text-muted-foreground">{fetchNotice}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={qwenOnly}
                  onCheckedChange={checked => {
                    setQwenOnly(checked)
                    if (fetchedModelIds) {
                      applyFetchedModels(fetchedModelIds, checked)
                    }
                  }}
                />
                <div className="space-y-0.5">
                  <p className="text-sm">Only Qwen-branded models</p>
                  <p className="text-xs text-muted-foreground">
                    Off includes every model on this endpoint (DeepSeek, Kimi,
                    GLM, MiniMax).
                  </p>
                </div>
              </div>
            </div>
          )}
          <ProviderField
            label="Models"
            hint="One per line: model id, or id|Display name."
          >
            <Textarea
              aria-label="Models"
              placeholder="anthropic/claude-sonnet-4|Sonnet 4"
              value={editModels}
              onChange={e => setEditModels(e.target.value)}
              className="min-h-[100px] font-mono text-base md:text-xs"
            />
          </ProviderField>
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
