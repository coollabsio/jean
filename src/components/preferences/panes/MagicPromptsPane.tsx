import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_PR_CONTENT_PROMPT,
  DEFAULT_COMMIT_MESSAGE_PROMPT,
  DEFAULT_CODE_REVIEW_PROMPT,
  DEFAULT_CONTEXT_SUMMARY_PROMPT,
  DEFAULT_RESOLVE_CONFLICTS_PROMPT,
  DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT,
  DEFAULT_RELEASE_NOTES_PROMPT,
  DEFAULT_SESSION_NAMING_PROMPT,
  DEFAULT_SESSION_RECAP_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
  DEFAULT_MAGIC_PROMPTS,
  DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_MAGIC_PROMPT_PROVIDERS,
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  codexModelOptions,
  isCodexModel,
  type MagicPrompts,
  type MagicPromptModels,
  type MagicPromptProviders,
  type MagicPromptModel,
} from '@/types/preferences'
import { cn } from '@/lib/utils'

interface VariableInfo {
  name: string
  description: string
}

interface PromptConfig {
  key: keyof MagicPrompts
  modelKey?: keyof MagicPromptModels
  providerKey?: keyof MagicPromptProviders
  label: string
  description: string
  variables: VariableInfo[]
  defaultValue: string
  defaultModel?: MagicPromptModel
}

interface PromptSection {
  label: string
  configs: PromptConfig[]
}

const PROMPT_SECTIONS: PromptSection[] = [
  {
    label: 'Investigation',
    configs: [
      {
        key: 'investigate_issue',
        modelKey: 'investigate_issue_model',
        providerKey: 'investigate_issue_provider',
        label: 'Investigate Issue',
        description:
          'Prompt for analyzing GitHub issues loaded into the context.',
        variables: [
          {
            name: '{issueRefs}',
            description: 'Issue numbers (e.g., #123, #456)',
          },
          {
            name: '{issueWord}',
            description: '"issue" or "issues" based on count',
          },
        ],
        defaultValue: DEFAULT_INVESTIGATE_ISSUE_PROMPT,
        defaultModel: 'opus',
      },
      {
        key: 'investigate_pr',
        modelKey: 'investigate_pr_model',
        providerKey: 'investigate_pr_provider',
        label: 'Investigate PR',
        description:
          'Prompt for analyzing GitHub pull requests loaded into the context.',
        variables: [
          {
            name: '{prRefs}',
            description: 'PR numbers (e.g., #123, #456)',
          },
          {
            name: '{prWord}',
            description: '"pull request" or "pull requests" based on count',
          },
        ],
        defaultValue: DEFAULT_INVESTIGATE_PR_PROMPT,
        defaultModel: 'opus',
      },
      {
        key: 'investigate_workflow_run',
        modelKey: 'investigate_workflow_run_model',
        providerKey: 'investigate_workflow_run_provider',
        label: 'Investigate Workflow Run',
        description:
          'Prompt for investigating failed GitHub Actions workflow runs.',
        variables: [
          {
            name: '{workflowName}',
            description: 'Name of the workflow (e.g., CI, Deploy)',
          },
          {
            name: '{runUrl}',
            description: 'URL to the workflow run on GitHub',
          },
          { name: '{runId}', description: 'Numeric ID of the workflow run' },
          { name: '{branch}', description: 'Branch the workflow ran on' },
          {
            name: '{displayTitle}',
            description: 'Commit message or PR title that triggered the run',
          },
        ],
        defaultValue: DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT,
        defaultModel: 'opus',
      },
    ],
  },
  {
    label: 'Git Operations',
    configs: [
      {
        key: 'code_review',
        modelKey: 'code_review_model',
        providerKey: 'code_review_provider',
        label: 'Code Review',
        description: 'Prompt for AI-powered code review of your changes.',
        variables: [
          {
            name: '{branch_info}',
            description: 'Source and target branch names',
          },
          { name: '{commits}', description: 'Commit history' },
          { name: '{diff}', description: 'Code changes diff' },
          {
            name: '{uncommitted_section}',
            description: 'Unstaged changes if any',
          },
        ],
        defaultValue: DEFAULT_CODE_REVIEW_PROMPT,
        defaultModel: 'opus',
      },
      {
        key: 'commit_message',
        modelKey: 'commit_message_model',
        providerKey: 'commit_message_provider',
        label: 'Commit Message',
        description:
          'Prompt for generating commit messages from staged changes.',
        variables: [
          { name: '{status}', description: 'Git status output' },
          { name: '{diff}', description: 'Staged changes diff' },
          {
            name: '{recent_commits}',
            description: 'Recent commit messages for style',
          },
          { name: '{remote_info}', description: 'Remote repository info' },
        ],
        defaultValue: DEFAULT_COMMIT_MESSAGE_PROMPT,
        defaultModel: 'haiku',
      },
      {
        key: 'pr_content',
        modelKey: 'pr_content_model',
        providerKey: 'pr_content_provider',
        label: 'PR Description',
        description:
          'Prompt for generating pull request titles and descriptions.',
        variables: [
          {
            name: '{current_branch}',
            description: 'Name of the feature branch',
          },
          {
            name: '{target_branch}',
            description: 'Branch to merge into (e.g., main)',
          },
          {
            name: '{commit_count}',
            description: 'Number of commits in the PR',
          },
          { name: '{commits}', description: 'List of commit messages' },
          { name: '{diff}', description: 'Git diff of all changes' },
        ],
        defaultValue: DEFAULT_PR_CONTENT_PROMPT,
        defaultModel: 'haiku',
      },
      {
        key: 'resolve_conflicts',
        modelKey: 'resolve_conflicts_model',
        providerKey: 'resolve_conflicts_provider',
        label: 'Resolve Conflicts',
        description: 'Instructions appended to conflict resolution prompts.',
        variables: [],
        defaultValue: DEFAULT_RESOLVE_CONFLICTS_PROMPT,
        defaultModel: 'opus',
      },
      {
        key: 'release_notes',
        modelKey: 'release_notes_model',
        providerKey: 'release_notes_provider',
        label: 'Release Notes',
        description:
          'Prompt for generating release notes from changes since a prior release.',
        variables: [
          {
            name: '{tag}',
            description: 'Tag of the selected release',
          },
          {
            name: '{previous_release_name}',
            description: 'Name of the selected release',
          },
          {
            name: '{commits}',
            description: 'Commit messages since the selected release',
          },
        ],
        defaultValue: DEFAULT_RELEASE_NOTES_PROMPT,
        defaultModel: 'haiku',
      },
    ],
  },
  {
    label: 'Session',
    configs: [
      {
        key: 'context_summary',
        modelKey: 'context_summary_model',
        providerKey: 'context_summary_provider',
        label: 'Context Summary',
        description:
          'Prompt for summarizing conversations when saving context.',
        variables: [
          {
            name: '{project_name}',
            description: 'Name of the current project',
          },
          { name: '{date}', description: 'Current timestamp' },
          {
            name: '{conversation}',
            description: 'Full conversation history',
          },
        ],
        defaultValue: DEFAULT_CONTEXT_SUMMARY_PROMPT,
        defaultModel: 'haiku',
      },
      {
        key: 'session_naming',
        modelKey: 'session_naming_model',
        providerKey: 'session_naming_provider',
        label: 'Session Naming',
        description:
          'Prompt for generating session titles from the first message. Used for both auto-naming and manual regeneration.',
        variables: [
          {
            name: '{message}',
            description: "The user's first message in the session",
          },
        ],
        defaultValue: DEFAULT_SESSION_NAMING_PROMPT,
        defaultModel: 'haiku',
      },
      {
        key: 'session_recap',
        modelKey: 'session_recap_model',
        providerKey: 'session_recap_provider',
        label: 'Session Recap',
        description:
          'Prompt for generating session recaps (digests) when returning to unfocused sessions.',
        variables: [
          {
            name: '{conversation}',
            description: 'Full conversation transcript',
          },
        ],
        defaultValue: DEFAULT_SESSION_RECAP_PROMPT,
        defaultModel: 'haiku',
      },
    ],
  },
  {
    label: 'System Prompts',
    configs: [
      {
        key: 'global_system_prompt',
        label: 'Global System Prompt',
        description:
          'Appended to every chat session. Works like ~/.claude/CLAUDE.md but managed in settings.',
        variables: [],
        defaultValue: DEFAULT_GLOBAL_SYSTEM_PROMPT,
      },
      {
        key: 'parallel_execution',
        label: 'Parallel Execution',
        description:
          'System prompt appended to every chat session when enabled in Experimental settings. Encourages sub-agent parallelization.',
        variables: [],
        defaultValue: DEFAULT_PARALLEL_EXECUTION_PROMPT,
      },
    ],
  },
]

// Flat list for lookups
const PROMPT_CONFIGS = PROMPT_SECTIONS.flatMap(s => s.configs)

const CLAUDE_MODEL_OPTIONS: { value: MagicPromptModel; label: string }[] = [
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'opus-4.5', label: 'Opus 4.5' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'sonnet-4.5', label: 'Sonnet 4.5' },
  { value: 'haiku', label: 'Haiku' },
]

const CODEX_MODEL_OPTIONS: { value: MagicPromptModel; label: string }[] =
  codexModelOptions.map(o => ({ value: o.value, label: o.label }))

const OPENCODE_MODEL_OPTIONS: { value: MagicPromptModel; label: string }[] = [
  { value: 'opencode/gpt-5.2-codex', label: 'GPT-5.2 Codex (OpenCode)' },
]

export const MagicPromptsPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()
  const [selectedKey, setSelectedKey] =
    useState<keyof MagicPrompts>('investigate_issue')
  const [localValue, setLocalValue] = useState('')
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const currentPrompts = preferences?.magic_prompts ?? DEFAULT_MAGIC_PROMPTS
  const currentModels =
    preferences?.magic_prompt_models ?? DEFAULT_MAGIC_PROMPT_MODELS
  const currentProviders =
    preferences?.magic_prompt_providers ?? DEFAULT_MAGIC_PROMPT_PROVIDERS
  const profiles = useMemo(
    () => preferences?.custom_cli_profiles ?? [],
    [preferences?.custom_cli_profiles]
  )
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const selectedConfig = PROMPT_CONFIGS.find(c => c.key === selectedKey)!
  const currentValue =
    currentPrompts[selectedKey] ?? selectedConfig.defaultValue
  const currentModel = selectedConfig.modelKey
    ? (currentModels[selectedConfig.modelKey] ?? selectedConfig.defaultModel)
    : undefined
  const currentProvider = selectedConfig.providerKey
    ? (currentProviders[selectedConfig.providerKey] ?? null)
    : undefined
  const currentModelIsCodex = currentModel ? isCodexModel(currentModel) : false
  const currentModelIsOpenCode = currentModel
    ? currentModel.startsWith('opencode/')
    : false
  const filteredClaudeOptions = useMemo(() => {
    if (!currentProvider || currentModelIsCodex || currentModelIsOpenCode) {
      return CLAUDE_MODEL_OPTIONS
    }
    const profile = profiles.find(p => p.name === currentProvider)
    if (!profile?.settings_json) return CLAUDE_MODEL_OPTIONS
    try {
      const settings = JSON.parse(profile.settings_json)
      const env = settings?.env
      if (!env) return CLAUDE_MODEL_OPTIONS
      const suffix = (m?: string) => (m ? ` (${m})` : '')
      return [
        {
          value: 'opus' as const,
          label: `Opus${suffix(env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL)}`,
        },
        {
          value: 'sonnet' as const,
          label: `Sonnet${suffix(env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL)}`,
        },
        {
          value: 'haiku' as const,
          label: `Haiku${suffix(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL)}`,
        },
      ] as { value: MagicPromptModel; label: string }[]
    } catch {
      return CLAUDE_MODEL_OPTIONS
    }
  }, [currentProvider, currentModelIsCodex, currentModelIsOpenCode, profiles])

  const isModified = currentPrompts[selectedKey] !== null

  // Sync local value when selection changes or external value updates
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalValue(currentValue)
  }, [currentValue, selectedKey])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

  const handleChange = useCallback(
    (newValue: string) => {
      setLocalValue(newValue)

      // Clear existing timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      // Set new timeout for debounced save
      saveTimeoutRef.current = setTimeout(() => {
        if (!preferences) return
        // Save null if matches default (auto-updates on new versions), otherwise save the value
        const valueToSave =
          newValue === selectedConfig.defaultValue ? null : newValue
        savePreferences.mutate({
          ...preferences,
          magic_prompts: {
            ...currentPrompts,
            [selectedKey]: valueToSave,
          },
        })
      }, 500)
    },
    [
      preferences,
      savePreferences,
      currentPrompts,
      selectedKey,
      selectedConfig.defaultValue,
    ]
  )

  const handleBlur = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    if (localValue !== currentValue && preferences) {
      const valueToSave =
        localValue === selectedConfig.defaultValue ? null : localValue
      savePreferences.mutate({
        ...preferences,
        magic_prompts: {
          ...currentPrompts,
          [selectedKey]: valueToSave,
        },
      })
    }
  }, [
    localValue,
    currentValue,
    preferences,
    savePreferences,
    currentPrompts,
    selectedKey,
    selectedConfig.defaultValue,
  ])

  const handleReset = useCallback(() => {
    if (!preferences) return
    savePreferences.mutate({
      ...preferences,
      magic_prompts: {
        ...currentPrompts,
        [selectedKey]: null,
      },
    })
  }, [preferences, savePreferences, currentPrompts, selectedKey])

  const handleModelChange = useCallback(
    (model: MagicPromptModel) => {
      if (!preferences || !selectedConfig.modelKey) return
      savePreferences.mutate({
        ...preferences,
        magic_prompt_models: {
          ...currentModels,
          [selectedConfig.modelKey]: model,
        },
      })
    },
    [preferences, savePreferences, currentModels, selectedConfig.modelKey]
  )

  const handleProviderChange = useCallback(
    (provider: string) => {
      if (!preferences || !selectedConfig.providerKey) return
      savePreferences.mutate({
        ...preferences,
        magic_prompt_providers: {
          ...currentProviders,
          [selectedConfig.providerKey]:
            provider === 'anthropic' ? null : provider,
        },
      })
    },
    [preferences, savePreferences, currentProviders, selectedConfig.providerKey]
  )

  const handleApplyClaudeDefaults = useCallback(() => {
    if (!preferences) return
    savePreferences.mutate({
      ...preferences,
      magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
      magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
    })
  }, [preferences, savePreferences])

  const handleApplyCodexDefaults = useCallback(() => {
    if (!preferences) return
    savePreferences.mutate({
      ...preferences,
      magic_prompt_models: CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
    })
  }, [preferences, savePreferences])

  const handleApplyOpenCodeDefaults = useCallback(() => {
    if (!preferences) return
    savePreferences.mutate({
      ...preferences,
      magic_prompt_models: OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
    })
  }, [preferences, savePreferences])

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Preset buttons */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <span className="text-xs text-muted-foreground">Presets:</span>
        <Button
          variant="outline"
          size="sm"
          onClick={handleApplyClaudeDefaults}
          className="h-7 text-xs"
        >
          Claude Defaults
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleApplyCodexDefaults}
          className="h-7 text-xs"
        >
          Codex Defaults
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleApplyOpenCodeDefaults}
          className="h-7 text-xs"
        >
          OpenCode Defaults
        </Button>
      </div>

      {/* Prompt selector grid grouped by section */}
      <div className="mb-4 shrink-0 space-y-3">
        {PROMPT_SECTIONS.map(section => (
          <div key={section.label}>
            <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
              {section.label}
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {section.configs.map(config => {
                const promptIsModified = currentPrompts[config.key] !== null
                const promptModel = config.modelKey
                  ? (currentModels[config.modelKey] ?? config.defaultModel)
                  : undefined
                const promptProvider = config.providerKey
                  ? (currentProviders[config.providerKey] ?? null)
                  : undefined
                return (
                  <button
                    key={config.key}
                    onClick={() => setSelectedKey(config.key)}
                    className={cn(
                      'px-3 py-2 rounded-lg border text-left transition-colors',
                      'hover:bg-muted/50',
                      selectedKey === config.key
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-card'
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-medium truncate">
                        {config.label}
                        {promptIsModified && (
                          <span className="text-muted-foreground ml-1">*</span>
                        )}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        {promptProvider && (
                          <span
                            className={cn(
                              'text-[10px] px-1.5 py-0.5 rounded font-medium',
                              'bg-primary/10 text-primary'
                            )}
                          >
                            {promptProvider}
                          </span>
                        )}
                        {promptModel && (
                          <span
                            className={cn(
                              'text-[10px] px-1.5 py-0.5 rounded font-medium',
                              'bg-muted text-muted-foreground'
                            )}
                          >
                            {promptModel}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Selected prompt details */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Header */}
        <div className="mb-3 shrink-0">
          <h3 className="text-sm font-medium">{selectedConfig.label}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {selectedConfig.description}
          </p>
          <div className="flex items-center gap-2 mt-2">
            {currentProvider !== undefined &&
              profiles.length > 0 &&
              !currentModelIsCodex &&
              !currentModelIsOpenCode && (
                <>
                  <span className="text-xs text-muted-foreground">
                    Provider
                  </span>
                  <Select
                    value={currentProvider ?? 'anthropic'}
                    onValueChange={handleProviderChange}
                  >
                    <SelectTrigger className="w-[130px] h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      {profiles.map(p => (
                        <SelectItem key={p.name} value={p.name}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            {currentModel && (
              <>
                <span className="text-xs text-muted-foreground">Model</span>
                <Select
                  value={currentModel}
                  onValueChange={(v: string) =>
                    handleModelChange(v as MagicPromptModel)
                  }
                >
                  <SelectTrigger className="w-[220px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Claude</SelectLabel>
                      {filteredClaudeOptions.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Codex <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">BETA</span></SelectLabel>
                      {CODEX_MODEL_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>OpenCode</SelectLabel>
                      {OPENCODE_MODEL_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={!isModified}
              className="gap-1.5 h-8"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          </div>
        </div>

        {/* Variables */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 shrink-0">
          {selectedConfig.variables.map(v => (
            <div key={v.name} className="flex items-baseline gap-1 text-xs">
              <code className="bg-muted px-1 py-0.5 rounded font-mono text-[11px]">
                {v.name}
              </code>
              <span className="text-muted-foreground">{v.description}</span>
            </div>
          ))}
        </div>

        {/* Textarea - fills remaining space */}
        <Textarea
          value={localValue}
          onChange={e => handleChange(e.target.value)}
          onBlur={handleBlur}
          className="flex-1 min-h-0 h-full font-mono text-xs resize-none"
          placeholder={selectedConfig.defaultValue}
        />
      </div>
    </div>
  )
}
