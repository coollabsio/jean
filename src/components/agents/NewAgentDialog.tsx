import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useSessionServerSources } from '@/services/multi-server-sessions'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import { cn } from '@/lib/utils'
import {
  useAgentTemplates,
  useCreateAgent,
  useInstallAgentTemplate,
  type AgentTemplate,
  type AgentTemplateSchedule,
} from '@/services/agents'
import { AGENT_COLOR_CHOICES } from './agents'
import { useAgentsEnabledServers } from './agents-feature'
import { AgentRunFields } from './AgentRunFields'
import {
  agentRunPatch,
  EMPTY_AGENT_RUN,
  type AgentRunDraft,
} from './agent-config'

interface NewAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (agentId: string) => void
  /** Server selected in the sidebar filter; new agents run there */
  defaultServerId?: string
}

type CreateMode = 'blank' | 'template'

/** Short timing label for a template schedule. */
export function templateScheduleLabel(schedule: AgentTemplateSchedule): string {
  if (schedule.kind === 'cron' && schedule.cron) {
    return `${schedule.cron} ${schedule.timezone ?? 'UTC'}`
  }
  if (schedule.kind === 'interval' && schedule.everySecs) {
    return `every ${Math.round(schedule.everySecs / 60)} min`
  }
  if (schedule.kind === 'event' && schedule.event) {
    return `on ${schedule.event}`
  }
  return schedule.kind
}

/** Create an agent from a blank form or from a predefined template. */
export function NewAgentDialog({
  open,
  onOpenChange,
  onCreated,
  defaultServerId = LOCAL_SERVER_ID,
}: NewAgentDialogProps) {
  const createAgent = useCreateAgent()
  const installTemplate = useInstallAgentTemplate()
  // New agents can run on any online server that has Agents turned on
  const enabledServers = useAgentsEnabledServers()
  const servers = useSessionServerSources().filter(
    source => source.online && enabledServers.includes(source.serverId)
  )
  // null = follow the sidebar's server filter until the user picks one
  const [chosenServerId, setChosenServerId] = useState<string | null>(null)
  const serverId = chosenServerId ?? defaultServerId
  // The server is offline (or "all servers"): use the first online one
  const targetServerId = servers.some(s => s.serverId === serverId)
    ? serverId
    : (servers[0]?.serverId ?? LOCAL_SERVER_ID)
  const [mode, setMode] = useState<CreateMode>('blank')
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rolePrompt, setRolePrompt] = useState('')
  const [icon, setIcon] = useState<string>(AGENT_COLOR_CHOICES[0])
  const [run, setRun] = useState<AgentRunDraft>(EMPTY_AGENT_RUN)
  const templateQuery = useAgentTemplates(
    targetServerId,
    open && mode === 'template'
  )
  const templates = templateQuery.data ?? []
  const selected =
    templates.find(template => template.id === templateId) ?? templates[0]

  const reset = () => {
    setMode('blank')
    setTemplateId(null)
    setName('')
    setDescription('')
    setRolePrompt('')
    setIcon(AGENT_COLOR_CHOICES[0])
    setChosenServerId(null)
    setRun(EMPTY_AGENT_RUN)
  }

  const handleCreate = () => {
    createAgent.mutate(
      {
        serverId: targetServerId,
        name,
        description,
        icon,
        rolePrompt,
        ...agentRunPatch(run),
      },
      {
        onSuccess: agent => {
          toast.success(`Agent ${agent.name} created`)
          onCreated(agent.key)
          onOpenChange(false)
          reset()
        },
        onError: error => toast.error(`Failed to create agent: ${error}`),
      }
    )
  }

  const handleInstall = () => {
    if (!selected) return
    installTemplate.mutate(
      { serverId: targetServerId, templateId: selected.id },
      {
        onSuccess: agent => {
          toast.success(`Agent ${agent.name} installed`)
          onCreated(agent.key)
          onOpenChange(false)
          reset()
        },
        onError: error => toast.error(`Failed to install template: ${error}`),
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Opened from inside the mobile sidebar sheet (z-80); sit above it
        overlayClassName="z-[90]"
        // Flex column: fixed header/footer, only the form scrolls, and long
        // skill rows truncate instead of widening the dialog past the screen
        className="z-[90] flex max-h-[calc(100dvh-2rem)] flex-col sm:max-h-[85vh] sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            {mode === 'template'
              ? 'Installs a custom agent you can edit or delete. Jean stays the coordinator.'
              : 'Its own chat, memory, and schedules, with access to your projects.'}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-1">
          <div
            className="flex gap-1 rounded-lg bg-muted p-1"
            role="tablist"
            aria-label="How to create the agent"
          >
            {(
              [
                ['blank', 'Blank'],
                ['template', 'From template'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                className={cn(
                  'flex-1 rounded-md px-2 py-1 text-sm transition-colors',
                  mode === value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {servers.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="agent-server">Server</Label>
              <NativeSelect
                id="agent-server"
                value={targetServerId}
                onChange={e => setChosenServerId(e.target.value)}
              >
                {servers.map(server => (
                  <NativeSelectOption
                    key={server.serverId}
                    value={server.serverId}
                  >
                    {server.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {mode === 'template' ? (
            <TemplatePicker
              loading={templateQuery.isLoading}
              error={templateQuery.error}
              templates={templates}
              selectedId={selected?.id}
              onSelect={setTemplateId}
            />
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  placeholder="Release Manager"
                  onChange={e => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label>Color</Label>
                <div
                  className="flex gap-2"
                  role="radiogroup"
                  aria-label="Color"
                >
                  {AGENT_COLOR_CHOICES.map(color => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={icon === color}
                      aria-label={color}
                      className={cn(
                        'rounded-md p-1 transition-colors',
                        icon === color
                          ? 'bg-primary/15 ring-1 ring-primary'
                          : 'hover:bg-muted'
                      )}
                      onClick={() => setIcon(color)}
                    >
                      <AgentIcon icon={color} className="size-6" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-description">Short description</Label>
                <Input
                  id="agent-description"
                  value={description}
                  placeholder="Prepares and checks releases"
                  onChange={e => setDescription(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-role">Role prompt</Label>
                <Textarea
                  id="agent-role"
                  value={rolePrompt}
                  rows={5}
                  placeholder="You are the release manager. Check open PRs, CI status and changelogs before releases..."
                  onChange={e => setRolePrompt(e.target.value)}
                />
              </div>
              {open && (
                <div className="flex flex-col gap-3 border-t pt-4">
                  <h3 className="text-sm font-medium">
                    Run configuration{' '}
                    <span className="font-normal text-muted-foreground">
                      · optional
                    </span>
                  </h3>
                  <AgentRunFields
                    idPrefix="new-agent"
                    serverId={targetServerId}
                    value={run}
                    onChange={setRun}
                    popoverClassName="z-[100]"
                  />
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {mode === 'template' ? (
            <Button
              onClick={handleInstall}
              disabled={
                !selected ||
                installTemplate.isPending ||
                templateQuery.isLoading
              }
            >
              Install template
            </Button>
          ) : (
            <Button
              onClick={handleCreate}
              disabled={!name.trim() || createAgent.isPending}
            >
              Create agent
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TemplatePicker({
  loading,
  error,
  templates,
  selectedId,
  onSelect,
}: {
  loading: boolean
  error: unknown
  templates: AgentTemplate[]
  selectedId: string | undefined
  onSelect: (id: string) => void
}) {
  const selected = templates.find(template => template.id === selectedId)
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading templates…</p>
  }
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Templates are unavailable: {String(error)}
      </p>
    )
  }
  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No templates on this server.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex max-h-52 flex-col gap-1 overflow-y-auto"
        role="listbox"
        aria-label="Agent templates"
      >
        {templates.map(template => {
          const pressed = template.id === selectedId
          return (
            <button
              key={template.id}
              type="button"
              role="option"
              aria-selected={pressed}
              data-testid={`agent-template-${template.id}`}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left',
                pressed ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-muted'
              )}
              onClick={() => onSelect(template.id)}
            >
              <AgentIcon icon={template.icon} className="size-8 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {template.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {template.description}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {selected && (
        <div className="space-y-2">
          {selected.skillHints.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Suggested skills: {selected.skillHints.join(', ')}
            </p>
          )}
          {selected.schedules.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {selected.schedules.map(schedule => (
                <li key={`${schedule.name}-${schedule.kind}`}>
                  {schedule.name}
                  <span className="ml-1.5 tabular-nums">
                    {templateScheduleLabel(schedule)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Textarea
            readOnly
            value={selected.rolePrompt}
            rows={6}
            aria-label="Role prompt preview"
          />
          <p className="text-xs text-muted-foreground">
            Run settings stay on the defaults. Edit the agent after install.
          </p>
        </div>
      )}
    </div>
  )
}
