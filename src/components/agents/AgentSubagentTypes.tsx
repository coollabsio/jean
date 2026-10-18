import { useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Play, Plus, Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import {
  useAgentDetails,
  useDeleteSubagentType,
  useSaveSubagentType,
  useSpawnSubagent,
  type AgentSummary,
  type SubagentType,
} from '@/services/agents'
import { AgentRunFields } from './AgentRunFields'
import {
  EMPTY_SUBAGENT_TYPE,
  PERMISSION_MODE_OPTIONS,
  TOOL_MODE_OPTIONS,
  draftFromSubagentType,
  resolveSubagentRun,
  subagentRunSummary,
  subagentTypeInput,
  validateSubagentTypeDraft,
  type SubagentTypeDraft,
} from './subagent-types'

function TypeEditor({
  draft,
  serverId,
  pending,
  onChange,
  onClose,
  onSave,
}: {
  draft: SubagentTypeDraft
  serverId: string
  pending: boolean
  onChange: (draft: SubagentTypeDraft) => void
  onClose: () => void
  onSave: () => void
}) {
  const [attempted, setAttempted] = useState(false)
  const error = validateSubagentTypeDraft(draft)
  return (
    <form
      className="space-y-3 rounded-md border px-3 py-3"
      onSubmit={event => {
        event.preventDefault()
        setAttempted(true)
        if (!error) onSave()
      }}
    >
      <p className="text-sm font-medium">
        {draft.id === null ? 'New subagent type' : `Edit ${draft.name}`}
      </p>
      <div className="space-y-1">
        <Label htmlFor="subagent-name">Name</Label>
        <Input
          id="subagent-name"
          value={draft.name}
          maxLength={64}
          onChange={event => onChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="subagent-description">Description</Label>
        <Input
          id="subagent-description"
          value={draft.description}
          maxLength={500}
          onChange={event =>
            onChange({ ...draft, description: event.target.value })
          }
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="subagent-instructions">Instructions</Label>
        <Textarea
          id="subagent-instructions"
          value={draft.instructions}
          rows={4}
          placeholder="Role prompt for this type. Leave blank to use the agent's role."
          onChange={event =>
            onChange({ ...draft, instructions: event.target.value })
          }
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.shared}
          onCheckedChange={checked =>
            onChange({ ...draft, shared: checked === true })
          }
        />
        Shared with every agent
      </label>
      <AgentRunFields
        idPrefix="subagent-type"
        serverId={serverId}
        value={draft}
        onChange={run => onChange({ ...draft, ...run })}
      />
      <div className="space-y-1.5 [&_[data-slot=native-select-wrapper]]:w-full">
        <Label htmlFor="subagent-permission">Permission mode</Label>
        <NativeSelect
          id="subagent-permission"
          value={draft.permissionMode}
          onChange={event =>
            onChange({ ...draft, permissionMode: event.target.value })
          }
        >
          <NativeSelectOption value="">Agent default</NativeSelectOption>
          {PERMISSION_MODE_OPTIONS.map(option => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5 [&_[data-slot=native-select-wrapper]]:w-full">
        <Label htmlFor="subagent-tools">Tools</Label>
        <NativeSelect
          id="subagent-tools"
          value={draft.toolMode}
          onChange={event =>
            onChange({ ...draft, toolMode: event.target.value })
          }
        >
          <NativeSelectOption value="">All tools</NativeSelectOption>
          {TOOL_MODE_OPTIONS.map(option => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">
          Read only limits the Jean tools to list, search, and notify. It does
          not stop file edits or shell commands; use Plan for that. Delete,
          push, and pull requests still need approval with all tools.
        </p>
      </div>
      {attempted && error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  )
}

function TypeRow({
  agent,
  type,
  onEdit,
}: {
  agent: AgentSummary
  type: SubagentType
  onEdit: (type: SubagentType) => void
}) {
  const remove = useDeleteSubagentType()
  const spawn = useSpawnSubagent()
  const [task, setTask] = useState('')
  const [open, setOpen] = useState(false)
  const summary = subagentRunSummary(resolveSubagentRun(agent, type))

  const handleSpawn = () => {
    const text = task.trim()
    if (!text) {
      toast.error('Write the task for this subagent')
      return
    }
    spawn.mutate(
      { agentId: agent.id, typeName: type.name, task: text },
      {
        onSuccess: () => {
          toast.success(`${type.name} started`)
          setTask('')
          setOpen(false)
        },
        onError: error => toast.error(`Failed to spawn: ${error}`),
      }
    )
  }

  return (
    <li className="rounded-md border px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {type.name}
            {type.shared ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Shared
              </span>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[type.description, summary].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(value => !value)}
        >
          <Play />
          Run
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${type.name}`}
          onClick={() => onEdit(type)}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${type.name}`}
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { agentId: agent.id, typeId: type.id },
              {
                onSuccess: () => toast.success(`${type.name} deleted`),
                onError: error => toast.error(`Failed to delete: ${error}`),
              }
            )
          }
        >
          <Trash2 />
        </Button>
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <Label htmlFor={`subagent-task-${type.id}`}>Task</Label>
          <Textarea
            id={`subagent-task-${type.id}`}
            value={task}
            rows={3}
            placeholder="What this subagent should do"
            onChange={event => setTask(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={spawn.isPending}
              onClick={handleSpawn}
            >
              Spawn
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** Subagent types for one agent: create, edit, delete, and spawn. */
export function AgentSubagentTypes({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const save = useSaveSubagentType()
  const [draft, setDraft] = useState<SubagentTypeDraft | null>(null)
  const types = data?.subagentTypes ?? []

  const handleSave = () => {
    if (!draft) return
    const error = validateSubagentTypeDraft(draft)
    if (error) return
    save.mutate(
      { agentId: agent.id, ...subagentTypeInput(draft) },
      {
        onSuccess: saved => {
          toast.success(
            draft.id === null ? `${saved.name} created` : `${saved.name} saved`
          )
          setDraft(null)
        },
        onError: error => toast.error(`Failed to save: ${error}`),
      }
    )
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Subagent types</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Named workers this agent can spawn. A type can override the backend,
            model, effort, skills, and tools. The result comes back as an
            update. A subagent cannot define types or spawn children.
          </p>
        </div>
        {draft === null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDraft(EMPTY_SUBAGENT_TYPE)}
          >
            <Plus />
            New type
          </Button>
        ) : null}
      </div>
      {draft ? (
        <TypeEditor
          draft={draft}
          serverId={agent.serverId}
          pending={save.isPending}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={handleSave}
        />
      ) : null}
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading types…</p>
      ) : types.length ? (
        <ul className="space-y-2">
          {types.map(type => (
            <TypeRow
              key={type.id}
              agent={agent}
              type={type}
              onEdit={type => setDraft(draftFromSubagentType(type))}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No subagent types yet.</p>
      )}
    </div>
  )
}
