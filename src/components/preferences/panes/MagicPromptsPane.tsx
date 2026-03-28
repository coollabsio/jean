import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Check, ChevronsUpDown, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { formatOpencodeModelLabel } from '@/components/chat/toolbar/toolbar-utils'
import { OPENCODE_MODEL_OPTIONS as OPENCODE_FALLBACK_OPTIONS } from '@/components/chat/toolbar/toolbar-options'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_PR_CONTENT_PROMPT,
  DEFAULT_COMMIT_MESSAGE_PROMPT,
  DEFAULT_CODE_REVIEW_PROMPT,
  DEFAULT_CONTEXT_SUMMARY_PROMPT,
  DEFAULT_RESOLVE_CONFLICTS_PROMPT,
  DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT,
  DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
  DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
  DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT,
  DEFAULT_RELEASE_NOTES_PROMPT,
  DEFAULT_REVIEW_COMMENTS_PROMPT,
  DEFAULT_SESSION_NAMING_PROMPT,
  DEFAULT_SESSION_RECAP_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
  DEFAULT_MAGIC_PROMPTS,
  DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_MAGIC_PROMPT_PROVIDERS,
  DEFAULT_MAGIC_PROMPT_BACKENDS,
  CLAUDE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  codexModelOptions,
  isCodexModel,
  type MagicPrompts,
  type MagicPromptModels,
  type MagicPromptProviders,
  type MagicPromptBackends,
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
  backendKey?: keyof MagicPromptBackends
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
        backendKey: 'investigate_issue_backend',
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
        backendKey: 'investigate_pr_backend',
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
        backendKey: 'investigate_workflow_run_backend',
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
      {
        key: 'investigate_security_alert',
        modelKey: 'investigate_security_alert_model',
        providerKey: 'investigate_security_alert_provider',
        backendKey: 'investigate_security_alert_backend',
        label: 'Investigate Dependabot Alert',
        description:
          'Prompt for investigating Dependabot vulnerability alerts in dependencies.',
        variables: [
          {
            name: '{alertRefs}',
            description:
              'Alert references (e.g., #42 lodash (critical), #43 express (high))',
          },
          {
            name: '{alertWord}',
            description: '"alert" or "alerts" based on count',
          },
        ],
        defaultValue: DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
        defaultModel: 'opus',
      },
      {
        key: 'investigate_advisory',
        modelKey: 'investigate_advisory_model',
        providerKey: 'investigate_advisory_provider',
        backendKey: 'investigate_advisory_backend',
        label: 'Investigate Security Advisory',
        description: 'Prompt for investigating repository security advisories.',
        variables: [
          {
            name: '{advisoryRefs}',
            description: 'Advisory references (e.g., GHSA-xxxx-yyyy (high))',
          },
          {
            name: '{advisoryWord}',
            description: '"advisory" or "advisories" based on count',
          },
        ],
        defaultValue: DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
        defaultModel: 'opus',
      },
      {
        key: 'investigate_linear_issue',
        modelKey: 'investigate_linear_issue_model',
        providerKey: 'investigate_linear_issue_provider',
        backendKey: 'investigate_linear_issue_backend',
        label: 'Investigate Linear Issue',
        description:
          'Prompt for analyzing Linear issues. Issue content is embedded directly since Claude CLI cannot access the Linear API.',
        variables: [
          {
            name: '{linearRefs}',
            description: 'Issue identifiers (e.g., ENG-123, ENG-456)',
          },
          {
            name: '{linearWord}',
            description: '"issue" or "issues" based on count',
          },
          {
            name: '{linearContext}',
            description: 'Full markdown content of the loaded Linear issues',
          },
        ],
        defaultValue: DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT,
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
        backendKey: 'code_review_backend',
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
        key: 'review_comments',
        modelKey: 'review_comments_model',
        providerKey: 'review_comments_provider',
        backendKey: 'review_comments_backend',
        label: 'Review Comments',
        description:
          'Prompt for addressing inline PR review comments selected from the Review Comments dialog.',
        variables: [
          {
            name: '{prNumber}',
            description: 'Pull request number',
          },
          {
            name: '{reviewComments}',
            description:
              'Formatted selected review comments with file paths, diffs, and bodies',
          },
        ],
        defaultValue: DEFAULT_REVIEW_COMMENTS_PROMPT,
        defaultModel: 'opus',
      },
      {
        key: 'commit_message',
        modelKey: 'commit_message_model',
        providerKey: 'commit_message_provider',
        backendKey: 'commit_message_backend',
        label: 'Commit Message',
        description:
          'Prompt for generating commit messages from staged changes.',
        variables: [
          {
            name: '{diff_stat}',
            description: 'Compact file change summary (git diff --stat)',
          },
          { name: '{status}', description: 'Git status output' },
          { name: '{diff}', description: 'Staged changes diff' },
          {
            name: '{recent_commits}',
            description: 'Recent commit messages for style',
          },
        ],
        defaultValue: DEFAULT_COMMIT_MESSAGE_PROMPT,
        defaultModel: 'sonnet',
      },
      {
        key: 'pr_content',
        modelKey: 'pr_content_model',
        providerKey: 'pr_content_provider',
        backendKey: 'pr_content_backend',
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
        defaultModel: 'sonnet',
      },
      {
        key: 'resolve_conflicts',
        modelKey: 'resolve_conflicts_model',
        providerKey: 'resolve_conflicts_provider',
        backendKey: 'resolve_conflicts_backend',
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
        backendKey: 'release_notes_backend',
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
        defaultModel: 'sonnet',
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
        backendKey: 'context_summary_backend',
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
        defaultModel: 'sonnet',
      },
      {
        key: 'session_naming',
        modelKey: 'session_naming_model',
        providerKey: 'session_naming_provider',
        backendKey: 'session_naming_backend',
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
        defaultModel: 'sonnet',
      },
      {
        key: 'session_recap',
        modelKey: 'session_recap_model',
        providerKey: 'session_recap_provider',
        backendKey: 'session_recap_backend',
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
        defaultModel: 'sonnet',
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
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'haiku', label: 'Haiku' },
]

const CODEX_MODEL_OPTIONS: { value: MagicPromptModel; label: string }[] =
  codexModelOptions.map(o => ({ value: o.value, label: o.label }))

export const MagicPromptsPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const [selectedKey, setSelectedKey] =
    useState<keyof MagicPrompts>('investigate_issue')
  const [localValue, setLocalValue] = useState('')
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const { data: availableOpencodeModels } = useAvailableOpencodeModels()
  const { installedBackends } = useInstalledBackends()

  const formatOpenCodeLabel = (value: string) => {
    const formatted = formatOpencodeModelLabel(value)
    return value.startsWith('opencode/')
      ? formatted.replace(/\s+\(OpenCode\)$/, '')
      : formatted
  }

  const opencodeModelOptions = useMemo(() => {
    const models = availableOpencodeModels?.length
      ? availableOpencodeModels
      : OPENCODE_FALLBACK_OPTIONS.map(o => o.value)
    return models.map(value => ({
      value: value as MagicPromptModel,
      label: formatOpenCodeLabel(value),
    }))
  }, [availableOpencodeModels])

  const currentPrompts = preferences?.magic_prompts ?? DEFAULT_MAGIC_PROMPTS
  const currentModels =
    preferences?.magic_prompt_models ?? DEFAULT_MAGIC_PROMPT_MODELS
  const currentProviders =
    preferences?.magic_prompt_providers ?? DEFAULT_MAGIC_PROMPT_PROVIDERS
  const currentBackends =
    preferences?.magic_prompt_backends ?? DEFAULT_MAGIC_PROMPT_BACKENDS
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
  const currentBackend = selectedConfig.backendKey
    ? (currentBackends[selectedConfig.backendKey] ?? null)
    : undefined
  // Resolve effective backend for model filtering: per-operation override > global default_backend
  const effectiveBackend =
    currentBackend ?? preferences?.default_backend ?? 'claude'
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
        patchPreferences.mutate({
          magic_prompts: {
            ...currentPrompts,
            [selectedKey]: valueToSave,
          },
        })
      }, 500)
    },
    [
      preferences,
      patchPreferences,
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
      patchPreferences.mutate({
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
    patchPreferences,
    currentPrompts,
    selectedKey,
    selectedConfig.defaultValue,
  ])

  const handleReset = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompts: {
        ...currentPrompts,
        [selectedKey]: null,
      },
    })
  }, [preferences, patchPreferences, currentPrompts, selectedKey])

  const handleModelChange = useCallback(
    (model: MagicPromptModel) => {
      if (!preferences || !selectedConfig.modelKey) return
      patchPreferences.mutate({
        magic_prompt_models: {
          ...currentModels,
          [selectedConfig.modelKey]: model,
        },
      })
    },
    [preferences, patchPreferences, currentModels, selectedConfig.modelKey]
  )

  const handleProviderChange = useCallback(
    (provider: string) => {
      if (!preferences || !selectedConfig.providerKey) return
      patchPreferences.mutate({
        magic_prompt_providers: {
          ...currentProviders,
          [selectedConfig.providerKey]:
            provider === 'anthropic' ? null : provider,
        },
      })
    },
    [
      preferences,
      patchPreferences,
      currentProviders,
      selectedConfig.providerKey,
    ]
  )

  const handleBackendChange = useCallback(
    (backend: string) => {
      if (!preferences || !selectedConfig.backendKey) return
      // Pick a sensible default model for the new backend
      let defaultModel: MagicPromptModel | undefined
      if (selectedConfig.modelKey) {
        if (backend === 'claude') {
          defaultModel = selectedConfig.defaultModel ?? 'haiku'
        } else if (backend === 'codex') {
          defaultModel = CODEX_MODEL_OPTIONS[0]?.value
        } else if (backend === 'opencode') {
          defaultModel = opencodeModelOptions[0]?.value
        }
      }
      patchPreferences.mutate({
        magic_prompt_backends: {
          ...currentBackends,
          [selectedConfig.backendKey]: backend,
        },
        ...(defaultModel && selectedConfig.modelKey
          ? {
              magic_prompt_models: {
                ...currentModels,
                [selectedConfig.modelKey]: defaultModel,
              },
            }
          : {}),
      })
    },
    [
      preferences,
      patchPreferences,
      currentBackends,
      currentModels,
      selectedConfig.backendKey,
      selectedConfig.modelKey,
      selectedConfig.defaultModel,
      opencodeModelOptions,
    ]
  )

  const handleApplyClaudeDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
      magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
      magic_prompt_backends: CLAUDE_DEFAULT_MAGIC_PROMPT_BACKENDS,
    })
  }, [preferences, patchPreferences])

  const handleApplyCodexDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
      magic_prompt_backends: CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
    })
  }, [preferences, patchPreferences])

  const handleApplyOpenCodeDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
      magic_prompt_backends: OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
    })
  }, [preferences, patchPreferences])

  // Flush pending save when switching prompts
  const prevSelectedKeyRef = useRef(selectedKey)
  useEffect(() => {
    if (prevSelectedKeyRef.current !== selectedKey) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      // Save pending changes for previous prompt
      const prevKey = prevSelectedKeyRef.current
      const prevConfig = PROMPT_CONFIGS.find(c => c.key === prevKey)
      if (prevConfig && preferences) {
        const prevValue = currentPrompts[prevKey] ?? prevConfig.defaultValue
        if (localValue !== prevValue) {
          const valueToSave =
            localValue === prevConfig.defaultValue ? null : localValue
          patchPreferences.mutate({
            magic_prompts: {
              ...currentPrompts,
              [prevKey]: valueToSave,
            },
          })
        }
      }
      prevSelectedKeyRef.current = selectedKey
    }
  }, [selectedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Preset buttons */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <span className="text-xs text-muted-foreground">Presets:</span>
        <Button
          variant="outline"
          size="sm"
          onClick={handleApplyClaudeDefaults}
          disabled={!installedBackends.includes('claude')}
          className="h-7 text-xs"
        >
          Claude Defaults
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleApplyCodexDefaults}
          disabled={!installedBackends.includes('codex')}
          className="h-7 text-xs"
        >
          Codex Defaults
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleApplyOpenCodeDefaults}
          disabled={!installedBackends.includes('opencode')}
          className="h-7 text-xs"
        >
          OpenCode Defaults
        </Button>
      </div>

      {/* Master-detail layout */}
      <div className="flex flex-1 min-h-0 gap-4">
        {/* Sidebar list */}
        <div className="w-[260px] shrink-0 overflow-y-auto pr-1">
          {PROMPT_SECTIONS.map((section, sectionIdx) => (
            <div key={section.label} className={sectionIdx > 0 ? 'mt-3' : ''}>
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1 px-2">
                {section.label}
              </h4>
              {section.configs.map(config => {
                const promptIsModified = currentPrompts[config.key] !== null
                return (
                  <button
                    key={config.key}
                    onClick={() => setSelectedKey(config.key)}
                    className={cn(
                      'w-full px-2 py-1.5 rounded-md text-left text-sm transition-colors truncate',
                      selectedKey === config.key
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/50 text-foreground'
                    )}
                  >
                    {config.label}
                    {promptIsModified && (
                      <span className="text-muted-foreground ml-1">*</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Detail panel */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Header */}
          <div className="mb-2 shrink-0">
            <h3 className="text-sm font-medium">{selectedConfig.label}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {selectedConfig.description}
            </p>
          </div>

          {/* Backend / Model / Provider / Reset row */}
          <div className="flex items-center gap-2 mb-2 shrink-0">
            {currentBackend !== undefined && (
              <>
                <span className="text-xs text-muted-foreground">Backend</span>
                <Select
                  value={effectiveBackend}
                  onValueChange={handleBackendChange}
                >
                  <SelectTrigger size="sm" className="w-[120px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {installedBackends.includes('claude') && (
                      <SelectItem value="claude">Claude</SelectItem>
                    )}
                    {installedBackends.includes('opencode') && (
                      <SelectItem value="opencode">OpenCode</SelectItem>
                    )}
                    {installedBackends.includes('codex') && (
                      <SelectItem value="codex">Codex</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </>
            )}
            {currentProvider !== undefined &&
              profiles.length > 0 &&
              !currentModelIsCodex &&
              !currentModelIsOpenCode &&
              effectiveBackend !== 'opencode' &&
              effectiveBackend !== 'codex' && (
                <>
                  <span className="text-xs text-muted-foreground">
                    Provider
                  </span>
                  <Select
                    value={currentProvider ?? 'anthropic'}
                    onValueChange={handleProviderChange}
                  >
                    <SelectTrigger size="sm" className="w-[130px] text-xs">
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
                <Popover
                  open={modelPopoverOpen}
                  onOpenChange={setModelPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={modelPopoverOpen}
                      className="w-[160px] h-8 text-xs justify-between font-normal"
                    >
                      <span className="truncate">
                        {(() => {
                          const allOptions = [
                            ...filteredClaudeOptions,
                            ...CODEX_MODEL_OPTIONS,
                            ...opencodeModelOptions,
                          ]
                          return (
                            allOptions.find(o => o.value === currentModel)
                              ?.label ??
                            (currentModel.startsWith('opencode/')
                              ? formatOpenCodeLabel(currentModel)
                              : currentModel)
                          )
                        })()}
                      </span>
                      <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[var(--radix-popover-trigger-width)] p-0"
                  >
                    <Command>
                      <CommandInput
                        placeholder="Search models..."
                        className="text-xs"
                      />
                      <CommandList>
                        <CommandEmpty>No models found.</CommandEmpty>
                        {effectiveBackend === 'claude' && (
                          <CommandGroup heading="Claude">
                            {filteredClaudeOptions.map(opt => (
                              <CommandItem
                                key={opt.value}
                                value={`${opt.label} ${opt.value}`}
                                onSelect={() => {
                                  handleModelChange(opt.value)
                                  setModelPopoverOpen(false)
                                }}
                              >
                                <span className="text-xs">{opt.label}</span>
                                <Check
                                  className={cn(
                                    'ml-auto h-3 w-3',
                                    currentModel === opt.value
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {effectiveBackend === 'codex' && (
                          <CommandGroup heading="Codex">
                            {CODEX_MODEL_OPTIONS.map(opt => (
                              <CommandItem
                                key={opt.value}
                                value={`${opt.label} ${opt.value}`}
                                onSelect={() => {
                                  handleModelChange(opt.value)
                                  setModelPopoverOpen(false)
                                }}
                              >
                                <span className="text-xs">{opt.label}</span>
                                <Check
                                  className={cn(
                                    'ml-auto h-3 w-3',
                                    currentModel === opt.value
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {effectiveBackend === 'opencode' && (
                          <CommandGroup heading="OpenCode">
                            {opencodeModelOptions.map(opt => (
                              <CommandItem
                                key={opt.value}
                                value={`${opt.label} ${opt.value}`}
                                onSelect={() => {
                                  handleModelChange(opt.value)
                                  setModelPopoverOpen(false)
                                }}
                              >
                                <span className="text-xs">{opt.label}</span>
                                <Check
                                  className={cn(
                                    'ml-auto h-3 w-3',
                                    currentModel === opt.value
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={!isModified}
              className="gap-1.5 h-7"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          </div>

          {/* Variables (compact horizontal flow) */}
          {selectedConfig.variables.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2 shrink-0">
              {selectedConfig.variables.map(v => (
                <span
                  key={v.name}
                  className="inline-flex items-center gap-1 text-[11px]"
                  title={v.description}
                >
                  <code className="bg-muted px-1 py-0.5 rounded font-mono">
                    {v.name}
                  </code>
                  <span className="text-muted-foreground">{v.description}</span>
                </span>
              ))}
            </div>
          )}

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
    </div>
  )
}
