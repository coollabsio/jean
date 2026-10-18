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
import { useCreateAgent } from '@/services/agents'
import { AGENT_COLOR_CHOICES } from './agents'
import { useAgentsEnabledServers } from './agents-feature'

interface NewAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (agentId: string) => void
  /** Server selected in the sidebar filter; new agents run there */
  defaultServerId?: string
}

/** Create an agent: name, color, short description and role prompt. */
export function NewAgentDialog({
  open,
  onOpenChange,
  onCreated,
  defaultServerId = LOCAL_SERVER_ID,
}: NewAgentDialogProps) {
  const createAgent = useCreateAgent()
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
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rolePrompt, setRolePrompt] = useState('')
  const [icon, setIcon] = useState<string>(AGENT_COLOR_CHOICES[0])

  const reset = () => {
    setName('')
    setDescription('')
    setRolePrompt('')
    setIcon(AGENT_COLOR_CHOICES[0])
    setChosenServerId(null)
  }

  const handleCreate = () => {
    createAgent.mutate(
      { serverId: targetServerId, name, description, icon, rolePrompt },
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Opened from inside the mobile sidebar sheet (z-80); sit above it
        overlayClassName="z-[90]"
        className="sm:max-w-lg z-[90]"
      >
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            An agent has its own chat, memory and schedules. Jean gives it
            access to all your projects through the Jean MCP tools.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
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
              <p className="text-xs text-muted-foreground">
                The agent runs on this Jean server and manages its projects.
              </p>
            </div>
          )}
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
            <div className="flex gap-2" role="radiogroup" aria-label="Color">
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || createAgent.isPending}
          >
            Create agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
