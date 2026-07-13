import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useAvailableCursorModels } from '@/services/cursor-cli'
import { useAvailableCommandCodeModels } from '@/services/commandcode-cli'
import { useAvailablePiModels } from '@/services/pi-cli'
import { useAvailableGrokModels } from '@/services/grok-cli'
import {
  getCatalogModelOptions,
  getCatalogModelReasoning,
  useModelCatalog,
} from '@/services/model-catalog'
import {
  formatCursorModelLabel,
  formatOpencodeModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import {
  COMMANDCODE_MODEL_OPTIONS as COMMANDCODE_FALLBACK_OPTIONS,
  CURSOR_MODEL_OPTIONS as CURSOR_FALLBACK_OPTIONS,
  OPENCODE_MODEL_OPTIONS as OPENCODE_FALLBACK_OPTIONS,
  PI_MODEL_OPTIONS as PI_FALLBACK_OPTIONS,
  GROK_MODEL_OPTIONS as GROK_FALLBACK_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
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
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
  DEFAULT_PROVIDER_SWITCH_HANDOFF_PROMPT,
  DEFAULT_MAGIC_PROMPTS,
  DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_MAGIC_PROMPT_PROVIDERS,
  DEFAULT_MAGIC_PROMPT_BACKENDS,
  DEFAULT_MAGIC_PROMPT_EFFORTS,
  DEFAULT_MAGIC_PROMPT_MODES,
  CLAUDE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  PI_DEFAULT_MAGIC_PROMPT_BACKENDS,
  COMMANDCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  GROK_DEFAULT_MAGIC_PROMPT_BACKENDS,
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_SOL_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_SOL_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_LUNA_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_LUNA_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_TERRA_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_56_TERRA_FAST_DEFAULT_MAGIC_PROMPT_MODELS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  PI_DEFAULT_MAGIC_PROMPT_MODELS,
  COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  GROK_DEFAULT_MAGIC_PROMPT_MODELS,
  codexModelOptions,
  isCommandCodeModel,
  isCodexModel,
  isCursorModel,
  isGrokModel,
  isPiModel,
  type MagicPrompts,
  type MagicPromptModels,
  type MagicPromptReasoningEfforts,
  type MagicPromptProviders,
  type MagicPromptBackends,
  type MagicPromptModel,
  type MagicPromptModes,
  type MagicPromptExecutionMode,
  type MagicCodeReviewConfig,
  type CliBackend,
  type CustomCliProfile,
} from '@/types/preferences'
import { cn } from '@/lib/utils'
import { BackendLabel } from '@/components/ui/backend-label'
import {
  codeReviewConfigKey,
  resolveCodeReviewConfigs,
} from '@/lib/code-review-configs'

interface VariableInfo {
  name: string
  description: string
}

interface PromptConfig {
  key: keyof MagicPrompts
  modelKey?: keyof MagicPromptModels
  effortKey?: keyof MagicPromptReasoningEfforts
  providerKey?: keyof MagicPromptProviders
  backendKey?: keyof MagicPromptBackends
  modeKey?: keyof MagicPromptModes
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
        effortKey: 'investigate_issue_effort',
        providerKey: 'investigate_issue_provider',
        backendKey: 'investigate_issue_backend',
        modeKey: 'investigate_issue_mode',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'investigate_pr',
        modelKey: 'investigate_pr_model',
        effortKey: 'investigate_pr_effort',
        providerKey: 'investigate_pr_provider',
        backendKey: 'investigate_pr_backend',
        modeKey: 'investigate_pr_mode',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'investigate_workflow_run',
        modelKey: 'investigate_workflow_run_model',
        effortKey: 'investigate_workflow_run_effort',
        providerKey: 'investigate_workflow_run_provider',
        backendKey: 'investigate_workflow_run_backend',
        modeKey: 'investigate_workflow_run_mode',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'investigate_security_alert',
        modelKey: 'investigate_security_alert_model',
        effortKey: 'investigate_security_alert_effort',
        providerKey: 'investigate_security_alert_provider',
        backendKey: 'investigate_security_alert_backend',
        modeKey: 'investigate_security_alert_mode',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'investigate_advisory',
        modelKey: 'investigate_advisory_model',
        effortKey: 'investigate_advisory_effort',
        providerKey: 'investigate_advisory_provider',
        backendKey: 'investigate_advisory_backend',
        modeKey: 'investigate_advisory_mode',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'investigate_linear_issue',
        modelKey: 'investigate_linear_issue_model',
        effortKey: 'investigate_linear_issue_effort',
        providerKey: 'investigate_linear_issue_provider',
        backendKey: 'investigate_linear_issue_backend',
        modeKey: 'investigate_linear_issue_mode',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
    ],
  },
  {
    label: 'Git Operations',
    configs: [
      {
        key: 'code_review',
        modelKey: 'code_review_model',
        effortKey: 'code_review_effort',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'review_comments',
        modelKey: 'review_comments_model',
        effortKey: 'review_comments_effort',
        providerKey: 'review_comments_provider',
        backendKey: 'review_comments_backend',
        modeKey: 'review_comments_mode',
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
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'commit_message',
        modelKey: 'commit_message_model',
        effortKey: 'commit_message_effort',
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
        effortKey: 'pr_content_effort',
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
          {
            name: '{context}',
            description: 'Loaded issue/PR/security/Linear context content',
          },
          {
            name: '{related_pull_requests}',
            description:
              'Exact PR reference strings derived from merged PRs mentioned in commit subjects.',
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
        effortKey: 'resolve_conflicts_effort',
        providerKey: 'resolve_conflicts_provider',
        backendKey: 'resolve_conflicts_backend',
        modeKey: 'resolve_conflicts_mode',
        label: 'Resolve Conflicts',
        description: 'Instructions appended to conflict resolution prompts.',
        variables: [],
        defaultValue: DEFAULT_RESOLVE_CONFLICTS_PROMPT,
        defaultModel: 'claude-opus-4-8[1m]',
      },
      {
        key: 'release_notes',
        modelKey: 'release_notes_model',
        effortKey: 'release_notes_effort',
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
          {
            name: '{pull_requests}',
            description:
              'Matched merged pull requests and detected issue references',
          },
          {
            name: '{related_pull_requests}',
            description:
              'Exact PR/issue reference formats detected from closing keywords',
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
        effortKey: 'context_summary_effort',
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
        effortKey: 'session_naming_effort',
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
    ],
  },
  {
    label: 'System Prompts',
    configs: [
      {
        key: 'parallel_execution',
        label: 'Parallel Execution',
        description:
          'System prompt appended to every chat session when enabled in General defaults. Encourages sub-agent parallelization.',
        variables: [],
        defaultValue: DEFAULT_PARALLEL_EXECUTION_PROMPT,
      },
      {
        key: 'global_system_prompt',
        label: 'Global System Prompt',
        description:
          'Global system prompt appended to every chat session (like ~/.claude/CLAUDE.md).',
        variables: [],
        defaultValue: DEFAULT_GLOBAL_SYSTEM_PROMPT,
      },
      {
        key: 'provider_switch_handoff',
        label: 'Provider Switch Handoff',
        description:
          'Hidden prompt prepended when a session switches between AI backends so the new provider uses Jean-local history as context.',
        variables: [
          {
            name: '{previous_backend}',
            description: 'Backend used by the previous run',
          },
          {
            name: '{current_backend}',
            description: 'Backend used by the current run',
          },
          {
            name: '{history}',
            description: 'Bounded Jean-local conversation history',
          },
        ],
        defaultValue: DEFAULT_PROVIDER_SWITCH_HANDOFF_PROMPT,
      },
    ],
  },
]

// Flat list for lookups
const PROMPT_CONFIGS = PROMPT_SECTIONS.flatMap(s => s.configs)
const PROMPT_CONFIG_KEYS = new Set(PROMPT_CONFIGS.map(config => config.key))
const MAGIC_PROMPT_HIGHLIGHT_DURATION_MS = 1800
const BACKEND_EFFORT_FALLBACK = {
  type: 'effort' as const,
  default: 'high',
  levels: [
    { value: 'low', label: 'Low', description: 'Light' },
    { value: 'medium', label: 'Medium', description: 'Moderate' },
    { value: 'high', label: 'High', description: 'Deep' },
    { value: 'xhigh', label: 'Extra high', description: 'Extra deep' },
  ],
}

function getMagicPromptModelReasoning(
  catalog: Parameters<typeof getCatalogModelReasoning>[0],
  backend: CliBackend,
  model: string,
  provider: string | null | undefined,
  profiles: CustomCliProfile[]
) {
  const profile =
    backend === 'claude' && provider
      ? profiles.find(candidate => candidate.name === provider)
      : undefined
  // Custom providers can remap Claude aliases to arbitrary models. Without
  // provider-specific catalog metadata, Anthropic effort levels are unsafe.
  if (profile) return null
  const reasoning = getCatalogModelReasoning(catalog, backend, model)
  if (reasoning !== undefined) return reasoning
  return ['opencode', 'pi', 'grok'].includes(backend)
    ? BACKEND_EFFORT_FALLBACK
    : undefined
}

function getMagicPromptReasoningDefaults(
  catalog: Parameters<typeof getCatalogModelReasoning>[0],
  backend: CliBackend,
  models: MagicPromptModels
): MagicPromptReasoningEfforts {
  const efforts = { ...DEFAULT_MAGIC_PROMPT_EFFORTS }
  for (const config of PROMPT_CONFIGS) {
    if (!config.modelKey || !config.effortKey) continue
    efforts[config.effortKey] =
      getMagicPromptModelReasoning(
        catalog,
        backend,
        models[config.modelKey],
        null,
        []
      )?.default ?? null
  }
  return efforts
}

function makeCodeReviewConfig(
  catalog: Parameters<typeof getCatalogModelReasoning>[0],
  backend: CliBackend,
  model: MagicPromptModel
): MagicCodeReviewConfig {
  return {
    backend,
    model,
    reasoning_effort:
      getMagicPromptModelReasoning(catalog, backend, model, null, [])
        ?.default ?? null,
  }
}

export function getMagicPromptItemId(key: keyof MagicPrompts): string {
  return `settings-magic-prompt-${key}`
}

const CODEX_MODEL_OPTIONS: { value: MagicPromptModel; label: string }[] = [
  { value: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { value: 'gpt-5.6-sol-fast', label: 'GPT 5.6 Sol Fast' },
  { value: 'gpt-5.6-terra', label: 'GPT 5.6 Terra' },
  { value: 'gpt-5.6-terra-fast', label: 'GPT 5.6 Terra Fast' },
  { value: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' },
  { value: 'gpt-5.6-luna-fast', label: 'GPT 5.6 Luna Fast' },
  { value: 'gpt-5.5', label: 'GPT 5.5' },
  { value: 'gpt-5.5-fast', label: 'GPT 5.5 Fast' },
  { value: 'gpt-5.4', label: 'GPT 5.4' },
  { value: 'gpt-5.4-fast', label: 'GPT 5.4 Fast' },
  { value: 'gpt-5.4-mini', label: 'GPT 5.4 Mini' },
  { value: 'gpt-5.4-mini-fast', label: 'GPT 5.4 Mini Fast' },
  ...codexModelOptions
    .filter(
      o =>
        ![
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.4',
          'gpt-5.4-mini',
        ].includes(o.value) // Already listed above
    )
    .map(o => ({ value: o.value as MagicPromptModel, label: o.label })),
]

interface MagicPromptsPaneProps {
  searchTargetPromptKey?: keyof MagicPrompts | null
}

export const MagicPromptsPane: React.FC<MagicPromptsPaneProps> = ({
  searchTargetPromptKey = null,
}) => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const [selectedKey, setSelectedKey] =
    useState<keyof MagicPrompts>('investigate_issue')
  const [highlightedKey, setHighlightedKey] = useState<
    keyof MagicPrompts | null
  >(null)
  const [localValue, setLocalValue] = useState('')
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const { data: availableOpencodeModels } = useAvailableOpencodeModels()
  const { data: availableCursorModels } = useAvailableCursorModels()
  const { data: availableCommandCodeModels } = useAvailableCommandCodeModels()
  const { data: availablePiModels } = useAvailablePiModels()
  const { data: availableGrokModels } = useAvailableGrokModels()
  const { data: modelCatalog } = useModelCatalog()
  const { installedBackends } = useInstalledBackends()

  const claudeModelOptions = useMemo(
    () =>
      getCatalogModelOptions(modelCatalog, 'claude').map(option => ({
        value: option.value as MagicPromptModel,
        label: option.label.replace(/^Claude\s+/, ''),
      })),
    [modelCatalog]
  )

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
  const cursorModelOptions = useMemo(() => {
    const models = availableCursorModels?.length
      ? availableCursorModels.map(model => ({
          value: `cursor/${model.id}`,
          label: model.label || formatCursorModelLabel(model.id),
        }))
      : CURSOR_FALLBACK_OPTIONS
    return models.map(option => ({
      value: option.value as MagicPromptModel,
      label: option.label || formatCursorModelLabel(option.value),
    }))
  }, [availableCursorModels])
  const commandCodeModelOptions = useMemo(() => {
    const options = availableCommandCodeModels?.length
      ? [
          { value: 'commandcode/default', label: 'CLI default (no --model)' },
          ...availableCommandCodeModels.map(model => ({
            value: `commandcode/${model.id}`,
            label: model.label,
          })),
        ]
      : COMMANDCODE_FALLBACK_OPTIONS
    return options.map(option => ({
      value: option.value as MagicPromptModel,
      label: option.label,
    }))
  }, [availableCommandCodeModels])

  const piModelOptions = useMemo(() => {
    const models = availablePiModels?.length
      ? availablePiModels.map(model => ({
          value: `pi/${model.id}`,
          label: model.label || model.id,
        }))
      : PI_FALLBACK_OPTIONS
    return models.map(option => ({
      value: option.value as MagicPromptModel,
      label: option.label,
    }))
  }, [availablePiModels])

  const grokModelOptions = useMemo(() => {
    const models = availableGrokModels?.length
      ? availableGrokModels.map(model => ({
          value: `grok/${model.id}`,
          label: model.label || model.id,
        }))
      : GROK_FALLBACK_OPTIONS
    return models.map(option => ({
      value: option.value as MagicPromptModel,
      label: option.label,
    }))
  }, [availableGrokModels])

  const currentPrompts = preferences?.magic_prompts ?? DEFAULT_MAGIC_PROMPTS
  const currentModels =
    preferences?.magic_prompt_models ?? DEFAULT_MAGIC_PROMPT_MODELS
  const currentProviders =
    preferences?.magic_prompt_providers ?? DEFAULT_MAGIC_PROMPT_PROVIDERS
  const currentBackends =
    preferences?.magic_prompt_backends ?? DEFAULT_MAGIC_PROMPT_BACKENDS
  const currentEfforts =
    preferences?.magic_prompt_efforts ?? DEFAULT_MAGIC_PROMPT_EFFORTS
  const currentModes =
    preferences?.magic_prompt_modes ?? DEFAULT_MAGIC_PROMPT_MODES
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
  const currentMode = selectedConfig.modeKey
    ? (currentModes[selectedConfig.modeKey] ??
      DEFAULT_MAGIC_PROMPT_MODES[selectedConfig.modeKey])
    : undefined
  // Resolve effective backend for model filtering: per-operation override > global default_backend
  const effectiveBackend =
    currentBackend ?? preferences?.default_backend ?? 'claude'
  const modelReasoning = currentModel
    ? getMagicPromptModelReasoning(
        modelCatalog,
        effectiveBackend as CliBackend,
        currentModel,
        currentProvider,
        profiles
      )
    : undefined
  const currentReasoning = selectedConfig.effortKey
    ? currentEfforts[selectedConfig.effortKey]
    : null
  const selectedReasoning = modelReasoning
    ? modelReasoning.levels.some(level => level.value === currentReasoning)
      ? currentReasoning
      : modelReasoning.default
    : null
  const currentModelIsCodex = currentModel ? isCodexModel(currentModel) : false
  const currentModelIsOpenCode = currentModel
    ? currentModel.startsWith('opencode/')
    : false
  const currentModelIsCursor = currentModel
    ? isCursorModel(currentModel)
    : false
  const currentModelIsCommandCode = currentModel
    ? isCommandCodeModel(currentModel)
    : false
  const currentModelIsPi = currentModel ? isPiModel(currentModel) : false
  const currentModelIsGrok = currentModel ? isGrokModel(currentModel) : false
  const filteredClaudeOptions = useMemo(() => {
    if (
      !currentProvider ||
      currentModelIsCodex ||
      currentModelIsOpenCode ||
      currentModelIsCursor ||
      currentModelIsCommandCode ||
      currentModelIsPi ||
      currentModelIsGrok
    ) {
      return claudeModelOptions
    }
    const profile = profiles.find(p => p.name === currentProvider)
    if (!profile?.settings_json) return claudeModelOptions
    try {
      const settings = JSON.parse(profile.settings_json)
      const env = settings?.env
      if (!env) return claudeModelOptions
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
      return claudeModelOptions
    }
  }, [
    claudeModelOptions,
    currentProvider,
    currentModelIsCodex,
    currentModelIsCursor,
    currentModelIsCommandCode,
    currentModelIsOpenCode,
    currentModelIsPi,
    currentModelIsGrok,
    profiles,
  ])

  const getReviewModelOptions = useCallback(
    (backend: string) => {
      if (backend === 'claude') return filteredClaudeOptions
      if (backend === 'codex') return CODEX_MODEL_OPTIONS
      if (backend === 'cursor') return cursorModelOptions
      if (backend === 'commandcode') return commandCodeModelOptions
      if (backend === 'pi') return piModelOptions
      if (backend === 'grok') return grokModelOptions
      return opencodeModelOptions
    },
    [
      commandCodeModelOptions,
      cursorModelOptions,
      filteredClaudeOptions,
      grokModelOptions,
      opencodeModelOptions,
      piModelOptions,
    ]
  )

  const getReviewReasoning = useCallback(
    (config: Pick<MagicCodeReviewConfig, 'backend' | 'model'>) =>
      getMagicPromptModelReasoning(
        modelCatalog,
        config.backend as CliBackend,
        config.model,
        config.backend === 'claude' ? currentProvider : null,
        profiles
      ),
    [modelCatalog, currentProvider, profiles]
  )

  const codeReviewConfigs = useMemo(
    () =>
      resolveCodeReviewConfigs({
        configured: preferences?.magic_code_review_configs,
        fallbackBackend: effectiveBackend,
        fallbackModel: currentModels.code_review_model,
      }),
    [
      currentModels.code_review_model,
      effectiveBackend,
      preferences?.magic_code_review_configs,
    ]
  )
  const showProviderControl =
    currentProvider !== undefined &&
    profiles.length > 0 &&
    (selectedKey === 'code_review'
      ? codeReviewConfigs.some(config => config.backend === 'claude')
      : effectiveBackend === 'claude')
  const hasPromptConfigControls =
    selectedKey !== 'code_review' &&
    (currentBackend !== undefined ||
      showProviderControl ||
      Boolean(currentModel) ||
      Boolean(selectedConfig.effortKey) ||
      Boolean(currentMode))

  const saveCodeReviewConfigs = useCallback(
    (configs: MagicCodeReviewConfig[]) => {
      if (!preferences || configs.length === 0) return
      const first = configs[0]
      if (!first) return
      patchPreferences.mutate({
        magic_code_review_configs: configs,
        magic_prompt_backends: {
          ...currentBackends,
          code_review_backend: first.backend,
        },
        magic_prompt_models: {
          ...currentModels,
          code_review_model: first.model,
        },
        magic_prompt_efforts: {
          ...currentEfforts,
          code_review_effort: first.reasoning_effort ?? null,
        },
      })
    },
    [
      preferences,
      patchPreferences,
      currentBackends,
      currentModels,
      currentEfforts,
    ]
  )

  const updateCodeReviewConfig = useCallback(
    (index: number, config: MagicCodeReviewConfig) => {
      const duplicate = codeReviewConfigs.some(
        (item, itemIndex) =>
          itemIndex !== index &&
          codeReviewConfigKey(item) === codeReviewConfigKey(config)
      )
      if (duplicate) return
      saveCodeReviewConfigs(
        codeReviewConfigs.map((item, itemIndex) =>
          itemIndex === index ? config : item
        )
      )
    },
    [codeReviewConfigs, saveCodeReviewConfigs]
  )

  const addCodeReviewConfig = useCallback(() => {
    if (codeReviewConfigs.length >= 5) return
    const representedBackends = new Set(
      codeReviewConfigs.map(config => config.backend)
    )
    const orderedBackends = [
      ...installedBackends.filter(backend => !representedBackends.has(backend)),
      ...installedBackends.filter(backend => representedBackends.has(backend)),
    ]
    for (const backend of orderedBackends) {
      const model = getReviewModelOptions(backend).find(
        option =>
          !codeReviewConfigs.some(
            config =>
              codeReviewConfigKey(config) ===
              codeReviewConfigKey({ backend, model: option.value })
          )
      )?.value
      if (model) {
        saveCodeReviewConfigs([
          ...codeReviewConfigs,
          {
            backend,
            model,
            reasoning_effort:
              getReviewReasoning({ backend, model })?.default ?? null,
          },
        ])
        return
      }
    }
  }, [
    codeReviewConfigs,
    getReviewModelOptions,
    getReviewReasoning,
    installedBackends,
    saveCodeReviewConfigs,
  ])

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
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (
      !searchTargetPromptKey ||
      !PROMPT_CONFIG_KEYS.has(searchTargetPromptKey)
    ) {
      return
    }

    setSelectedKey(searchTargetPromptKey)
    setHighlightedKey(searchTargetPromptKey)

    const targetElement = document.getElementById(
      getMagicPromptItemId(searchTargetPromptKey)
    )
    targetElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })

    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current)
    }
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedKey(current =>
        current === searchTargetPromptKey ? null : current
      )
      highlightTimeoutRef.current = null
    }, MAGIC_PROMPT_HIGHLIGHT_DURATION_MS)
  }, [searchTargetPromptKey])

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
      const reasoning = getMagicPromptModelReasoning(
        modelCatalog,
        effectiveBackend as CliBackend,
        model,
        currentProvider,
        profiles
      )
      patchPreferences.mutate({
        magic_prompt_models: {
          ...currentModels,
          [selectedConfig.modelKey]: model,
        },
        ...(selectedConfig.effortKey
          ? {
              magic_prompt_efforts: {
                ...currentEfforts,
                [selectedConfig.effortKey]: reasoning?.default ?? null,
              },
            }
          : {}),
      })
    },
    [
      preferences,
      selectedConfig.modelKey,
      selectedConfig.effortKey,
      modelCatalog,
      effectiveBackend,
      patchPreferences,
      currentModels,
      currentEfforts,
      currentProvider,
      profiles,
    ]
  )

  const handleReasoningChange = useCallback(
    (reasoning: string) => {
      if (!preferences || !selectedConfig.effortKey) return
      patchPreferences.mutate({
        magic_prompt_efforts: {
          ...currentEfforts,
          [selectedConfig.effortKey]: reasoning,
        },
      })
    },
    [preferences, selectedConfig.effortKey, patchPreferences, currentEfforts]
  )

  const handleProviderChange = useCallback(
    (provider: string) => {
      if (!preferences || !selectedConfig.providerKey) return
      const selectedProvider = provider === 'anthropic' ? null : provider
      const reasoning = currentModel
        ? getMagicPromptModelReasoning(
            modelCatalog,
            effectiveBackend as CliBackend,
            currentModel,
            selectedProvider,
            profiles
          )
        : undefined
      const reviewConfigs =
        selectedKey === 'code_review'
          ? codeReviewConfigs.map(config => ({
              ...config,
              reasoning_effort:
                getMagicPromptModelReasoning(
                  modelCatalog,
                  config.backend as CliBackend,
                  config.model,
                  config.backend === 'claude' ? selectedProvider : null,
                  profiles
                )?.default ?? null,
            }))
          : undefined
      patchPreferences.mutate({
        magic_prompt_providers: {
          ...currentProviders,
          [selectedConfig.providerKey]: selectedProvider,
        },
        ...(selectedConfig.effortKey
          ? {
              magic_prompt_efforts: {
                ...currentEfforts,
                [selectedConfig.effortKey]: reasoning?.default ?? null,
              },
            }
          : {}),
        ...(reviewConfigs ? { magic_code_review_configs: reviewConfigs } : {}),
      })
    },
    [
      preferences,
      patchPreferences,
      currentProviders,
      currentEfforts,
      currentModel,
      modelCatalog,
      effectiveBackend,
      profiles,
      selectedKey,
      codeReviewConfigs,
      selectedConfig.providerKey,
      selectedConfig.effortKey,
    ]
  )

  const handleBackendChange = useCallback(
    (backend: string) => {
      if (!preferences || !selectedConfig.backendKey) return
      // Pick a sensible default model for the new backend
      let defaultModel: MagicPromptModel | undefined
      if (selectedConfig.modelKey) {
        if (backend === 'claude') {
          defaultModel = selectedConfig.defaultModel ?? 'sonnet'
        } else if (backend === 'codex') {
          defaultModel = CODEX_MODEL_OPTIONS[0]?.value
        } else if (backend === 'opencode') {
          defaultModel = opencodeModelOptions[0]?.value
        } else if (backend === 'cursor') {
          defaultModel = cursorModelOptions[0]?.value
        } else if (backend === 'pi') {
          defaultModel = piModelOptions[0]?.value
        } else if (backend === 'commandcode') {
          defaultModel = commandCodeModelOptions[0]?.value
        } else if (backend === 'grok') {
          defaultModel = grokModelOptions[0]?.value
        }
      }
      const reasoning = defaultModel
        ? getMagicPromptModelReasoning(
            modelCatalog,
            backend as CliBackend,
            defaultModel,
            backend === 'claude' ? currentProvider : null,
            profiles
          )
        : undefined
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
        ...(selectedConfig.effortKey
          ? {
              magic_prompt_efforts: {
                ...currentEfforts,
                [selectedConfig.effortKey]: reasoning?.default ?? null,
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
      currentEfforts,
      modelCatalog,
      currentProvider,
      profiles,
      selectedConfig.backendKey,
      selectedConfig.modelKey,
      selectedConfig.effortKey,
      selectedConfig.defaultModel,
      cursorModelOptions,
      piModelOptions,
      commandCodeModelOptions,
      grokModelOptions,
      opencodeModelOptions,
    ]
  )

  const handleModeChange = useCallback(
    (mode: MagicPromptExecutionMode) => {
      if (!preferences || !selectedConfig.modeKey) return
      patchPreferences.mutate({
        magic_prompt_modes: {
          ...currentModes,
          [selectedConfig.modeKey]: mode,
        },
      })
    },
    [preferences, patchPreferences, currentModes, selectedConfig.modeKey]
  )

  const handleApplyClaudeDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: DEFAULT_MAGIC_PROMPT_MODELS,
      magic_code_review_configs: [
        makeCodeReviewConfig(
          modelCatalog,
          'claude',
          DEFAULT_MAGIC_PROMPT_MODELS.code_review_model
        ),
      ],
      magic_prompt_providers: DEFAULT_MAGIC_PROMPT_PROVIDERS,
      magic_prompt_backends: CLAUDE_DEFAULT_MAGIC_PROMPT_BACKENDS,
      magic_prompt_efforts: getMagicPromptReasoningDefaults(
        modelCatalog,
        'claude',
        DEFAULT_MAGIC_PROMPT_MODELS
      ),
    })
  }, [preferences, patchPreferences, modelCatalog])

  const handleApplyCodexDefaults = useCallback(
    (models: MagicPromptModels) => {
      if (!preferences) return
      const presetModels = {
        ...models,
        commit_message_model:
          CODEX_56_LUNA_FAST_DEFAULT_MAGIC_PROMPT_MODELS.commit_message_model,
      }
      patchPreferences.mutate({
        magic_prompt_models: presetModels,
        magic_code_review_configs: [
          makeCodeReviewConfig(modelCatalog, 'codex', models.code_review_model),
        ],
        magic_prompt_backends: CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_prompt_efforts: {
          ...getMagicPromptReasoningDefaults(
            modelCatalog,
            'codex',
            presetModels
          ),
          commit_message_effort: 'low',
        },
      })
    },
    [preferences, patchPreferences, modelCatalog]
  )

  const handleApplyLegacyCodexDefaults = useCallback(
    () => handleApplyCodexDefaults(CODEX_DEFAULT_MAGIC_PROMPT_MODELS),
    [handleApplyCodexDefaults]
  )

  const handleApplyCodexFastDefaults = useCallback(
    () => handleApplyCodexDefaults(CODEX_FAST_DEFAULT_MAGIC_PROMPT_MODELS),
    [handleApplyCodexDefaults]
  )

  const handleApplyOpenCodeDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
      magic_code_review_configs: [
        makeCodeReviewConfig(
          modelCatalog,
          'opencode',
          OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS.code_review_model
        ),
      ],
      magic_prompt_backends: OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
      magic_prompt_efforts: getMagicPromptReasoningDefaults(
        modelCatalog,
        'opencode',
        OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS
      ),
    })
  }, [preferences, patchPreferences, modelCatalog])

  const handleApplyPiDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: PI_DEFAULT_MAGIC_PROMPT_MODELS,
      magic_code_review_configs: [
        makeCodeReviewConfig(
          modelCatalog,
          'pi',
          PI_DEFAULT_MAGIC_PROMPT_MODELS.code_review_model
        ),
      ],
      magic_prompt_backends: PI_DEFAULT_MAGIC_PROMPT_BACKENDS,
      magic_prompt_efforts: getMagicPromptReasoningDefaults(
        modelCatalog,
        'pi',
        PI_DEFAULT_MAGIC_PROMPT_MODELS
      ),
    })
  }, [preferences, patchPreferences, modelCatalog])

  const handleApplyCommandCodeDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS,
      magic_code_review_configs: [
        makeCodeReviewConfig(
          modelCatalog,
          'commandcode',
          COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS.code_review_model
        ),
      ],
      magic_prompt_backends: COMMANDCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
      magic_prompt_efforts: DEFAULT_MAGIC_PROMPT_EFFORTS,
    })
  }, [preferences, patchPreferences])

  const handleApplyGrokDefaults = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({
      magic_prompt_models: GROK_DEFAULT_MAGIC_PROMPT_MODELS,
      magic_code_review_configs: [
        makeCodeReviewConfig(
          modelCatalog,
          'grok',
          GROK_DEFAULT_MAGIC_PROMPT_MODELS.code_review_model
        ),
      ],
      magic_prompt_backends: GROK_DEFAULT_MAGIC_PROMPT_BACKENDS,
      magic_prompt_efforts: getMagicPromptReasoningDefaults(
        modelCatalog,
        'grok',
        GROK_DEFAULT_MAGIC_PROMPT_MODELS
      ),
    })
  }, [preferences, patchPreferences, modelCatalog])

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
      {/* Preset menu */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <span className="text-xs text-muted-foreground">Presets:</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs">
              Apply preset
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={handleApplyClaudeDefaults}
              disabled={!installedBackends.includes('claude')}
            >
              Claude Defaults
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                handleApplyCodexDefaults(
                  CODEX_56_SOL_DEFAULT_MAGIC_PROMPT_MODELS
                )
              }
              disabled={!installedBackends.includes('codex')}
            >
              GPT 5.6 Sol
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                handleApplyCodexDefaults(
                  CODEX_56_SOL_FAST_DEFAULT_MAGIC_PROMPT_MODELS
                )
              }
              disabled={!installedBackends.includes('codex')}
            >
              GPT 5.6 Sol Fast
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                handleApplyCodexDefaults(
                  CODEX_56_LUNA_DEFAULT_MAGIC_PROMPT_MODELS
                )
              }
              disabled={!installedBackends.includes('codex')}
            >
              GPT 5.6 Luna
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                handleApplyCodexDefaults(
                  CODEX_56_LUNA_FAST_DEFAULT_MAGIC_PROMPT_MODELS
                )
              }
              disabled={!installedBackends.includes('codex')}
            >
              GPT 5.6 Luna Fast
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                handleApplyCodexDefaults(
                  CODEX_56_TERRA_DEFAULT_MAGIC_PROMPT_MODELS
                )
              }
              disabled={!installedBackends.includes('codex')}
            >
              GPT 5.6 Terra
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                handleApplyCodexDefaults(
                  CODEX_56_TERRA_FAST_DEFAULT_MAGIC_PROMPT_MODELS
                )
              }
              disabled={!installedBackends.includes('codex')}
            >
              GPT 5.6 Terra Fast
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleApplyLegacyCodexDefaults}
              disabled={!installedBackends.includes('codex')}
            >
              Codex Defaults
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleApplyCodexFastDefaults}
              disabled={!installedBackends.includes('codex')}
            >
              Codex (Fast) Defaults
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={handleApplyOpenCodeDefaults}
              disabled={!installedBackends.includes('opencode')}
            >
              OpenCode Defaults
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleApplyPiDefaults}
              disabled={!installedBackends.includes('pi')}
            >
              Pi Defaults
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleApplyCommandCodeDefaults}
              disabled={!installedBackends.includes('commandcode')}
            >
              Command Code Defaults
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={handleApplyGrokDefaults}
              disabled={!installedBackends.includes('grok')}
            >
              Grok Defaults
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Master-detail layout */}
      <div className="flex flex-1 min-h-0 flex-col gap-3 md:flex-row md:gap-4">
        <div className="md:hidden shrink-0">
          <Select
            value={selectedKey}
            onValueChange={value => setSelectedKey(value as keyof MagicPrompts)}
          >
            <SelectTrigger aria-label="Magic prompt" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROMPT_SECTIONS.map(section => (
                <React.Fragment key={section.label}>
                  {section.configs.map(config => (
                    <SelectItem key={config.key} value={config.key}>
                      {config.label}
                    </SelectItem>
                  ))}
                </React.Fragment>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Sidebar list */}
        <div
          data-testid="magic-prompts-sidebar"
          className="hidden w-[260px] shrink-0 overflow-y-auto pr-1 md:block"
        >
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
                    id={getMagicPromptItemId(config.key)}
                    data-settings-target={config.key}
                    className={cn(
                      'w-full px-2 py-1.5 rounded-md text-left text-sm transition-colors truncate ring-1 ring-transparent',
                      selectedKey === config.key
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/50 text-foreground',
                      highlightedKey === config.key
                        ? 'ring-border bg-accent/40'
                        : ''
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
          <div
            data-testid={
              hasPromptConfigControls ? 'magic-prompt-config' : undefined
            }
            className={cn(
              'mb-2 shrink-0',
              hasPromptConfigControls
                ? 'flex w-full flex-col gap-2 rounded-lg border border-border/60 p-2.5'
                : 'flex flex-wrap items-center gap-2'
            )}
          >
            {selectedKey === 'code_review' && (
              <div className="flex w-full flex-col gap-2">
                {codeReviewConfigs.map((config, index) => {
                  const reasoning = getReviewReasoning(config)
                  const selectedReviewReasoning = reasoning
                    ? reasoning.levels.some(
                        level => level.value === config.reasoning_effort
                      )
                      ? config.reasoning_effort
                      : reasoning.default
                    : null
                  return (
                    <div
                      data-testid={`magic-code-review-config-${index}`}
                      key={`${codeReviewConfigKey(config)}-${index}`}
                      className="flex flex-col gap-2 rounded-lg border border-border/60 p-2.5"
                    >
                      <div className="flex h-7 items-center justify-between">
                        <span className="text-xs font-medium">
                          Review {index + 1}
                        </span>
                        {codeReviewConfigs.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove review ${index + 1}`}
                            onClick={() =>
                              saveCodeReviewConfigs(
                                codeReviewConfigs.filter(
                                  (_, itemIndex) => itemIndex !== index
                                )
                              )
                            }
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Backend
                        </span>
                        <Select
                          value={config.backend}
                          onValueChange={backend => {
                            const model = getReviewModelOptions(backend).find(
                              option =>
                                !codeReviewConfigs.some(
                                  (item, itemIndex) =>
                                    itemIndex !== index &&
                                    codeReviewConfigKey(item) ===
                                      codeReviewConfigKey({
                                        backend,
                                        model: option.value,
                                      })
                                )
                            )?.value
                            if (model) {
                              updateCodeReviewConfig(index, {
                                backend,
                                model,
                                reasoning_effort:
                                  getReviewReasoning({ backend, model })
                                    ?.default ?? null,
                              })
                            }
                          }}
                        >
                          <SelectTrigger
                            aria-label={`Review ${index + 1} backend`}
                            size="sm"
                            className="w-full text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {installedBackends.map(backend => (
                              <SelectItem key={backend} value={backend}>
                                <BackendLabel backend={backend} />
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Model
                        </span>
                        <Select
                          value={config.model}
                          onValueChange={model =>
                            updateCodeReviewConfig(index, {
                              ...config,
                              model: model as MagicPromptModel,
                              reasoning_effort:
                                getReviewReasoning({
                                  backend: config.backend,
                                  model: model as MagicPromptModel,
                                })?.default ?? null,
                            })
                          }
                        >
                          <SelectTrigger
                            aria-label={`Review ${index + 1} model`}
                            size="sm"
                            className="w-full min-w-0 text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {getReviewModelOptions(config.backend).map(
                              option => {
                                const duplicate = codeReviewConfigs.some(
                                  (item, itemIndex) =>
                                    itemIndex !== index &&
                                    codeReviewConfigKey(item) ===
                                      codeReviewConfigKey({
                                        backend: config.backend,
                                        model: option.value,
                                      })
                                )
                                return (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                    disabled={duplicate}
                                  >
                                    {option.label}
                                  </SelectItem>
                                )
                              }
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Reasoning
                        </span>
                        <Select
                          value={selectedReviewReasoning ?? undefined}
                          onValueChange={reasoningEffort =>
                            updateCodeReviewConfig(index, {
                              ...config,
                              reasoning_effort: reasoningEffort,
                            })
                          }
                          disabled={!reasoning}
                        >
                          <SelectTrigger
                            aria-label={`Review ${index + 1} reasoning`}
                            size="sm"
                            className="w-full min-w-0 text-xs"
                          >
                            <SelectValue placeholder="Not supported" />
                          </SelectTrigger>
                          <SelectContent>
                            {reasoning?.levels.map(level => (
                              <SelectItem key={level.value} value={level.value}>
                                {level.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )
                })}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={addCodeReviewConfig}
                  disabled={codeReviewConfigs.length >= 5}
                >
                  <Plus className="size-3.5" />
                  Add review
                </Button>
              </div>
            )}
            {selectedKey !== 'code_review' && currentBackend !== undefined && (
              <div
                data-testid="magic-prompt-backend-control"
                className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2"
              >
                <span className="text-xs text-muted-foreground">Backend</span>
                <Select
                  value={effectiveBackend}
                  onValueChange={handleBackendChange}
                >
                  <SelectTrigger
                    aria-label="Backend"
                    size="sm"
                    className="w-full min-w-0 text-xs"
                    hideIcon={installedBackends.length <= 1}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {installedBackends.includes('claude') && (
                      <SelectItem value="claude">Claude</SelectItem>
                    )}
                    {installedBackends.includes('opencode') && (
                      <SelectItem value="opencode">OpenCode</SelectItem>
                    )}
                    {installedBackends.includes('cursor') && (
                      <SelectItem value="cursor">
                        <BackendLabel backend="cursor" />
                      </SelectItem>
                    )}
                    {installedBackends.includes('pi') && (
                      <SelectItem value="pi" aria-label="PI (Beta)">
                        <BackendLabel backend="pi" />
                      </SelectItem>
                    )}
                    {installedBackends.includes('commandcode') && (
                      <SelectItem
                        value="commandcode"
                        aria-label="Command Code (Beta)"
                      >
                        <BackendLabel backend="commandcode" />
                      </SelectItem>
                    )}
                    {installedBackends.includes('codex') && (
                      <SelectItem value="codex">Codex</SelectItem>
                    )}
                    {installedBackends.includes('grok') && (
                      <SelectItem value="grok" aria-label="Grok (Beta)">
                        <BackendLabel backend="grok" />
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}
            {showProviderControl && (
              <div
                data-testid="magic-prompt-provider-control"
                className="grid w-full grid-cols-[72px_minmax(0,1fr)] items-center gap-2"
              >
                <span className="text-xs text-muted-foreground">Provider</span>
                <Select
                  value={currentProvider ?? 'anthropic'}
                  onValueChange={handleProviderChange}
                >
                  <SelectTrigger
                    aria-label="Provider"
                    size="sm"
                    className="w-full min-w-0 text-xs"
                  >
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
              </div>
            )}
            {selectedKey !== 'code_review' && currentModel && (
              <div
                data-testid="magic-prompt-model-control"
                className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2"
              >
                <span className="text-xs text-muted-foreground">Model</span>
                <Popover
                  open={modelPopoverOpen}
                  onOpenChange={setModelPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-label="Model"
                      aria-expanded={modelPopoverOpen}
                      className="h-8 w-full min-w-0 justify-between text-xs font-normal"
                    >
                      <span className="truncate">
                        {(() => {
                          const allOptions = [
                            ...filteredClaudeOptions,
                            ...CODEX_MODEL_OPTIONS,
                            ...opencodeModelOptions,
                            ...cursorModelOptions,
                            ...commandCodeModelOptions,
                            ...piModelOptions,
                            ...grokModelOptions,
                          ]
                          return (
                            allOptions.find(o => o.value === currentModel)
                              ?.label ??
                            (currentModel.startsWith('opencode/')
                              ? formatOpenCodeLabel(currentModel)
                              : isCursorModel(currentModel)
                                ? formatCursorModelLabel(currentModel)
                                : currentModel === 'commandcode/default'
                                  ? 'CLI default (no --model)'
                                  : isPiModel(currentModel)
                                    ? currentModel.replace(/^pi\//, '')
                                    : isGrokModel(currentModel)
                                      ? currentModel.replace(/^grok\//, '')
                                      : currentModel)
                          )
                        })()}
                      </span>
                      {(effectiveBackend === 'claude'
                        ? filteredClaudeOptions
                        : effectiveBackend === 'codex'
                          ? CODEX_MODEL_OPTIONS
                          : effectiveBackend === 'cursor'
                            ? cursorModelOptions
                            : effectiveBackend === 'commandcode'
                              ? commandCodeModelOptions
                              : effectiveBackend === 'pi'
                                ? piModelOptions
                                : effectiveBackend === 'grok'
                                  ? grokModelOptions
                                  : opencodeModelOptions
                      ).length > 1 && (
                        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
                      )}
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
                        {effectiveBackend === 'cursor' && (
                          <CommandGroup
                            heading={<BackendLabel backend="cursor" />}
                          >
                            {cursorModelOptions.map(opt => (
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
                        {effectiveBackend === 'pi' && (
                          <CommandGroup heading={<BackendLabel backend="pi" />}>
                            {piModelOptions.map(opt => (
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
                        {effectiveBackend === 'commandcode' && (
                          <CommandGroup
                            heading={<BackendLabel backend="commandcode" />}
                          >
                            {commandCodeModelOptions.map(opt => (
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
              </div>
            )}
            {selectedConfig.effortKey && selectedKey !== 'code_review' && (
              <div
                data-testid="magic-prompt-reasoning-control"
                className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2"
              >
                <span className="text-xs text-muted-foreground">
                  {modelReasoning?.type === 'thinking'
                    ? 'Thinking'
                    : 'Reasoning'}
                </span>
                <Select
                  value={selectedReasoning ?? undefined}
                  onValueChange={handleReasoningChange}
                  disabled={!modelReasoning}
                >
                  <SelectTrigger
                    aria-label="Reasoning level"
                    size="sm"
                    className="w-full min-w-0 text-xs"
                  >
                    <SelectValue placeholder="Not supported" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelReasoning?.levels.map(level => (
                      <SelectItem key={level.value} value={level.value}>
                        {level.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {currentMode && (
              <div
                data-testid="magic-prompt-mode-control"
                className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2"
              >
                <span className="text-xs text-muted-foreground">Mode</span>
                <Select value={currentMode} onValueChange={handleModeChange}>
                  <SelectTrigger
                    aria-label="Default mode"
                    size="sm"
                    className="w-full min-w-0 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plan">Plan</SelectItem>
                    <SelectItem value="yolo">Yolo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
            className="flex-1 min-h-0 h-full font-mono text-base resize-none md:text-xs"
            placeholder={selectedConfig.defaultValue}
          />
        </div>
      </div>
    </div>
  )
}
