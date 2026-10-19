import {
  ANTIGRAVITY_EFFORT_LEVEL_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  CODEX_EFFORT_LEVEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  COMMANDCODE_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
  GROK_EFFORT_LEVEL_OPTIONS,
  GROK_MODEL_OPTIONS,
  KIMI_EFFORT_LEVEL_OPTIONS,
  KIMI_MODEL_OPTIONS,
  DEVIN_MODEL_OPTIONS,
  MODEL_OPTIONS,
  MUSE_EFFORT_LEVEL_OPTIONS,
  MUSE_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  PI_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import type { AgentPatch, AgentSkill, AgentSummary } from '@/services/agents'
import { backendOptions, type CliBackend } from '@/types/preferences'

export interface AgentRunDraft {
  /** Empty string means the current session and user default. */
  backend: string
  model: string
  effort: string
  thinkingLevel: string
  skills: AgentSkill[]
}

export const EMPTY_AGENT_RUN: AgentRunDraft = {
  backend: '',
  model: '',
  effort: '',
  thinkingLevel: '',
  skills: [],
}

export interface LabeledOption {
  value: string
  label: string
}

const MODEL_OPTIONS_BY_BACKEND: Record<CliBackend, LabeledOption[]> = {
  claude: MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
  opencode: OPENCODE_MODEL_OPTIONS,
  cursor: CURSOR_MODEL_OPTIONS,
  pi: PI_MODEL_OPTIONS,
  commandcode: COMMANDCODE_MODEL_OPTIONS,
  grok: GROK_MODEL_OPTIONS,
  kimi: KIMI_MODEL_OPTIONS,
  devin: DEVIN_MODEL_OPTIONS,
  antigravity: ANTIGRAVITY_MODEL_OPTIONS,
  muse: MUSE_MODEL_OPTIONS,
}

const EFFORT_OPTIONS_BY_BACKEND: Partial<Record<CliBackend, LabeledOption[]>> =
  {
    claude: EFFORT_LEVEL_OPTIONS,
    codex: CODEX_EFFORT_LEVEL_OPTIONS,
    pi: PI_EFFORT_LEVEL_OPTIONS,
    grok: GROK_EFFORT_LEVEL_OPTIONS,
    kimi: KIMI_EFFORT_LEVEL_OPTIONS,
    antigravity: ANTIGRAVITY_EFFORT_LEVEL_OPTIONS,
    muse: MUSE_EFFORT_LEVEL_OPTIONS,
  }

function isCliBackend(value: string): value is CliBackend {
  return backendOptions.some(option => option.value === value)
}

/** Backends the picker can offer. An empty install list shows every backend. */
export function backendChoices(
  installed: readonly string[],
  current: string,
  stillLoading: boolean
): { value: CliBackend; label: string }[] {
  if (stillLoading || installed.length === 0) return [...backendOptions]
  const allowed = new Set(
    installed.filter((backend): backend is CliBackend => isCliBackend(backend))
  )
  if (isCliBackend(current)) allowed.add(current)
  const choices = backendOptions.filter(option => allowed.has(option.value))
  return choices.length > 0 ? choices : [...backendOptions]
}

export function modelOptionsForBackend(backend: string): LabeledOption[] {
  return isCliBackend(backend) ? MODEL_OPTIONS_BY_BACKEND[backend] : []
}

export function effortOptionsForBackend(backend: string): LabeledOption[] {
  return isCliBackend(backend) ? (EFFORT_OPTIONS_BY_BACKEND[backend] ?? []) : []
}

/** Claude sessions store a thinking level separately from effort. */
export function thinkingOptionsForBackend(backend: string): LabeledOption[] {
  return backend === 'claude' ? THINKING_LEVEL_OPTIONS : []
}

export interface SkillGroupInput {
  backend: CliBackend
  skills: { name: string; path: string; description?: string }[]
}

export interface SkillChoice {
  name: string
  path: string
  description?: string
  backend: CliBackend
}

/** Skills for the selected backend, or every group when the backend is unset. */
export function skillChoices(
  groups: SkillGroupInput[],
  backend: string
): SkillChoice[] {
  const seen = new Set<string>()
  const choices: SkillChoice[] = []
  for (const group of groups) {
    if (backend && group.backend !== backend) continue
    for (const skill of group.skills) {
      if (!skill.path || seen.has(skill.path)) continue
      seen.add(skill.path)
      choices.push({
        name: skill.name,
        path: skill.path,
        description: skill.description,
        backend: group.backend,
      })
    }
  }
  return choices
}

export function toggleSkill(
  selected: AgentSkill[],
  skill: SkillChoice,
  on: boolean
): AgentSkill[] {
  if (!on) return selected.filter(item => item.path !== skill.path)
  if (selected.some(item => item.path === skill.path)) return selected
  return [
    ...selected,
    { name: skill.name, path: skill.path, backend: skill.backend },
  ]
}

/** Drop model, effort, thinking, and skills that do not belong to `backend`. */
export function withBackend(
  draft: AgentRunDraft,
  backend: string
): AgentRunDraft {
  const models = new Set(
    modelOptionsForBackend(backend).map(option => option.value)
  )
  const efforts = new Set(
    effortOptionsForBackend(backend).map(option => option.value)
  )
  const thinking = new Set(
    thinkingOptionsForBackend(backend).map(option => option.value)
  )
  return {
    ...draft,
    backend,
    model: models.has(draft.model) ? draft.model : '',
    effort: efforts.has(draft.effort) ? draft.effort : '',
    thinkingLevel: thinking.has(draft.thinkingLevel) ? draft.thinkingLevel : '',
    skills: draft.skills.filter(
      skill => !backend || !skill.backend || skill.backend === backend
    ),
  }
}

/** Picker value for "inherit": the draft stores it as an empty string. */
export const AGENT_DEFAULT_OPTION = '__default__'

export function toPickerValue(value: string): string {
  return value || AGENT_DEFAULT_OPTION
}

export function fromPickerValue(value: string): string {
  return value === AGENT_DEFAULT_OPTION ? '' : value
}

/** Apply a backend + model picked in the shared backend/model picker. */
export function withBackendModel(
  draft: AgentRunDraft,
  backend: string,
  model: string
): AgentRunDraft {
  const next = backend === draft.backend ? draft : withBackend(draft, backend)
  return { ...next, model: fromPickerValue(model) }
}

/** Backend the picker opens on: the agent's own, else the new-chat default. */
export function pickerBackend(
  draft: AgentRunDraft,
  fallback: string | undefined,
  choices: readonly string[]
): CliBackend {
  if (isCliBackend(draft.backend)) return draft.backend
  if (fallback && isCliBackend(fallback) && choices.includes(fallback))
    return fallback
  const first = choices.find(isCliBackend)
  return first ?? 'claude'
}

/** Effort or thinking options with a leading "Default" (inherit) entry. */
export function withDefaultReasoningOption<T extends LabeledOption>(
  options: readonly T[]
): (LabeledOption & { description?: string })[] {
  return [
    {
      value: AGENT_DEFAULT_OPTION,
      label: 'Default',
      description: 'Same as a new chat',
    },
    ...options,
  ]
}

export function draftFromAgent(
  agent: Pick<
    AgentSummary,
    'backend' | 'model' | 'effort' | 'thinkingLevel' | 'skills'
  >
): AgentRunDraft {
  return {
    backend: agent.backend ?? '',
    model: agent.model ?? '',
    effort: agent.effort ?? '',
    thinkingLevel: agent.thinkingLevel ?? '',
    skills: agent.skills ?? [],
  }
}

export function agentRunPatch(
  draft: AgentRunDraft
): Pick<
  AgentPatch,
  'backend' | 'model' | 'effort' | 'thinkingLevel' | 'skills'
> {
  return {
    backend: draft.backend || null,
    model: draft.model || null,
    effort: draft.effort || null,
    thinkingLevel: draft.thinkingLevel || null,
    skills: draft.skills.map(skill => ({
      name: skill.name,
      path: skill.path,
      backend: skill.backend ?? null,
    })),
  }
}

export function sameAgentRun(a: AgentRunDraft, b: AgentRunDraft): boolean {
  const paths = (skills: AgentSkill[]) =>
    skills
      .map(skill => skill.path)
      .slice()
      .sort()
      .join('\n')
  return (
    a.backend === b.backend &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.thinkingLevel === b.thinkingLevel &&
    paths(a.skills) === paths(b.skills)
  )
}

/** One line for the agent header. Null when the agent uses every default. */
export function agentRunSummary(agent: {
  backend: string | null
  model: string | null
  skills: { name: string }[]
}): string | null {
  const parts: string[] = []
  if (agent.backend) {
    parts.push(
      backendOptions.find(option => option.value === agent.backend)?.label ??
        agent.backend
    )
  }
  if (agent.model) parts.push(agent.model)
  if (agent.skills.length > 0) {
    const count = agent.skills.length
    parts.push(`${count} skill${count === 1 ? '' : 's'}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
