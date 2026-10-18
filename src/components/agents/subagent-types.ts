import type {
  AgentSkill,
  AgentSummary,
  SubagentType,
  SubagentTypeInput,
} from '@/services/agents'
import {
  agentRunPatch,
  draftFromAgent,
  type AgentRunDraft,
} from './agent-config'

export const SUBAGENT_NAME_MAX = 64
export const SUBAGENT_DESCRIPTION_MAX = 500
export const SUBAGENT_INSTRUCTIONS_MAX = 8000

export const PERMISSION_MODE_OPTIONS = [
  { value: 'plan', label: 'Plan' },
  { value: 'build', label: 'Build' },
  { value: 'yolo', label: 'Yolo' },
] as const

export const TOOL_MODE_OPTIONS = [
  { value: 'read_only', label: 'Read only' },
] as const

export interface SubagentTypeDraft extends AgentRunDraft {
  id: number | null
  name: string
  description: string
  instructions: string
  shared: boolean
  /** Empty string keeps the normal agent wake mode. */
  permissionMode: string
  /** Empty string keeps the agent's tools. `read_only` blocks writes. */
  toolMode: string
}

export const EMPTY_SUBAGENT_TYPE: SubagentTypeDraft = {
  ...{
    backend: '',
    model: '',
    effort: '',
    thinkingLevel: '',
    skills: [],
  },
  id: null,
  name: '',
  description: '',
  instructions: '',
  shared: false,
  permissionMode: '',
  toolMode: '',
}

export interface ResolvedSubagentRun {
  instructions: string
  backend: string | null
  model: string | null
  effort: string | null
  thinkingLevel: string | null
  skills: AgentSkill[]
  permissionMode: string | null
  toolMode: string | null
}

function setOrInherit(
  override: string | null | undefined,
  fallback: string | null | undefined
): string | null {
  const value = override?.trim()
  if (value) return value
  const base = fallback?.trim()
  return base ? base : null
}

/** Type fields replace the agent. Blank type fields keep the agent's value. */
export function resolveSubagentRun(
  agent: Pick<
    AgentSummary,
    'rolePrompt' | 'backend' | 'model' | 'effort' | 'thinkingLevel' | 'skills'
  >,
  type: Pick<
    SubagentType,
    | 'instructions'
    | 'backend'
    | 'model'
    | 'effort'
    | 'thinkingLevel'
    | 'skills'
    | 'permissionMode'
    | 'toolMode'
  >
): ResolvedSubagentRun {
  return {
    instructions: type.instructions.trim() || agent.rolePrompt,
    backend: setOrInherit(type.backend, agent.backend),
    model: setOrInherit(type.model, agent.model),
    effort: setOrInherit(type.effort, agent.effort),
    thinkingLevel: setOrInherit(type.thinkingLevel, agent.thinkingLevel),
    skills: type.skills.length > 0 ? type.skills : agent.skills,
    permissionMode: setOrInherit(type.permissionMode, null),
    toolMode: setOrInherit(type.toolMode, null),
  }
}

export function validateSubagentTypeDraft(
  draft: SubagentTypeDraft
): string | null {
  const name = draft.name.trim()
  if (!name) return 'Name is required'
  if ([...name].length > SUBAGENT_NAME_MAX) return 'Name is too long'
  if (name.includes('\n') || name.includes('\r')) {
    return 'Name cannot contain a newline'
  }
  if ([...draft.description.trim()].length > SUBAGENT_DESCRIPTION_MAX) {
    return 'Description is too long'
  }
  if ([...draft.instructions.trim()].length > SUBAGENT_INSTRUCTIONS_MAX) {
    return 'Instructions are too long'
  }
  return null
}

export function subagentTypeInput(draft: SubagentTypeDraft): SubagentTypeInput {
  const run = agentRunPatch(draft)
  return {
    ...(draft.id === null ? {} : { id: draft.id }),
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
    shared: draft.shared,
    backend: run.backend ?? null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    thinkingLevel: run.thinkingLevel ?? null,
    skills: run.skills ?? [],
    permissionMode: draft.permissionMode.trim() || null,
    toolMode: draft.toolMode.trim() || null,
  }
}

export function draftFromSubagentType(type: SubagentType): SubagentTypeDraft {
  return {
    ...draftFromAgent({
      backend: type.backend,
      model: type.model,
      effort: type.effort,
      thinkingLevel: type.thinkingLevel,
      skills: type.skills,
    }),
    id: type.id,
    name: type.name,
    description: type.description,
    instructions: type.instructions,
    shared: type.shared || type.agentId === null,
    permissionMode: type.permissionMode ?? '',
    toolMode: type.toolMode ?? '',
  }
}

const KIND_LABELS: Record<string, string> = {
  schedule: 'Schedule',
  delegation: 'Follow-up',
  message: 'Agent request',
  approval: 'Approval',
  subagent: 'Subagent',
}

/** Tasks tab label. A spawned task includes its type name. */
export function taskKindLabel(
  kind: string,
  typeName: string | null | undefined
): string {
  const base = KIND_LABELS[kind] ?? kind
  const name = typeName?.trim()
  return name ? `${base} · ${name}` : base
}

/** One line under a type: resolved backend and any restriction. */
export function subagentRunSummary(run: ResolvedSubagentRun): string {
  const parts: string[] = []
  if (run.backend) parts.push(run.backend)
  if (run.model) parts.push(run.model)
  if (run.effort) parts.push(run.effort)
  if (run.permissionMode) parts.push(run.permissionMode)
  if (run.toolMode === 'read_only') parts.push('read only')
  if (run.skills.length > 0) {
    const count = run.skills.length
    parts.push(`${count} skill${count === 1 ? '' : 's'}`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'Agent defaults'
}
