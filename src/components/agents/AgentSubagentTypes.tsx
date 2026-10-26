import { useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Play, Plus, Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
  AgentBadge,
  AgentEmpty,
  AgentList,
  AgentLoading,
  AgentPanel,
  AgentSection,
  AgentTabBody,
  HelpTip,
} from './agent-ui'
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
      onSubmit={event => {
        event.preventDefault()
        setAttempted(true)
        if (!error) onSave()
      }}
    >
      <AgentPanel>
        <p className="text-sm font-medium">
          {draft.id === null ? 'New subagent type' : `Edit ${draft.name}`}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subagent-name">Name</Label>
            <Input
              id="subagent-name"
              value={draft.name}
              maxLength={64}
              placeholder="Changelog drafter"
              aria-invalid={attempted && Boolean(error) && !draft.name.trim()}
              onChange={event =>
                onChange({ ...draft, name: event.target.value })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subagent-description">Description</Label>
            <Input
              id="subagent-description"
              value={draft.description}
              maxLength={500}
              placeholder="What this worker is for"
              onChange={event =>
                onChange({ ...draft, description: event.target.value })
              }
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
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
        <div className="border-t pt-3">
          <AgentRunFields
            idPrefix="subagent-type"
            serverId={serverId}
            value={draft}
            inheritFrom="this agent"
            onChange={run => onChange({ ...draft, ...run })}
          />
        </div>
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2 [&_[data-slot=native-select-wrapper]]:w-full">
          <div className="flex flex-col gap-1.5">
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
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5">
              <Label htmlFor="subagent-tools">Tools</Label>
              <HelpTip label="About tools">
                Read only limits the Jean tools to list, search, and notify. It
                does not stop file edits or shell commands; use Plan for that.
                Delete, push, and pull requests still need approval with all
                tools.
              </HelpTip>
            </span>
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
          </div>
        </div>
        {attempted && error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="-mx-4 -mb-4 flex justify-end gap-2 border-t bg-muted/20 px-4 py-2.5">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {draft.id === null ? 'Create type' : 'Save'}
          </Button>
        </div>
      </AgentPanel>
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
    <li className="px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{type.name}</span>
            {type.shared ? <AgentBadge>Shared</AgentBadge> : null}
          </p>
          {type.description ? (
            <p className="truncate text-xs text-muted-foreground">
              {type.description}
            </p>
          ) : null}
          {summary ? (
            <p className="mt-1 truncate text-[11px] text-muted-foreground/80">
              {summary}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant={open ? 'secondary' : 'outline'}
            size="sm"
            className="mr-1"
            aria-expanded={open}
            onClick={() => setOpen(value => !value)}
          >
            <Play />
            Run
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${type.name}`}
                onClick={() => onEdit(type)}
              >
                <Pencil />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
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
                      onError: error =>
                        toast.error(`Failed to delete: ${error}`),
                    }
                  )
                }
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {open ? (
        <div className="mt-3 flex flex-col gap-2 rounded-md bg-muted/30 p-3">
          <Label htmlFor={`subagent-task-${type.id}`}>Task</Label>
          <Textarea
            id={`subagent-task-${type.id}`}
            value={task}
            rows={3}
            placeholder="What this subagent should do"
            onChange={event => setTask(event.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
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
    <AgentTabBody>
      <AgentSection
        title="Subagent types"
        count={isLoading ? undefined : types.length}
        description="Named workers this agent can spawn. A type can override the backend, model, effort, skills, and tools. The result comes back as an update. A subagent cannot define types or spawn children."
        actions={
          draft === null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDraft(EMPTY_SUBAGENT_TYPE)}
            >
              <Plus />
              New type
            </Button>
          ) : null
        }
      >
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
          <AgentLoading label="Loading types…" />
        ) : types.length ? (
          <AgentList>
            {types.map(type => (
              <TypeRow
                key={type.id}
                agent={agent}
                type={type}
                onEdit={type => setDraft(draftFromSubagentType(type))}
              />
            ))}
          </AgentList>
        ) : draft === null ? (
          <AgentEmpty title="No subagent types yet." />
        ) : null}
      </AgentSection>
    </AgentTabBody>
  )
}
