import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useUpdateAgent, type AgentSummary } from '@/services/agents'
import {
  agentRunPatch,
  draftFromAgent,
  sameAgentRun,
  type AgentRunDraft,
} from './agent-config'
import { AgentRunFields } from './AgentRunFields'

/** Edit the backend, model, reasoning, and skills of an existing agent. */
export function AgentSettings({ agent }: { agent: AgentSummary }) {
  const updateAgent = useUpdateAgent()
  const saved = draftFromAgent(agent)
  const [draft, setDraft] = useState<AgentRunDraft>(saved)
  const [seen, setSeen] = useState<AgentRunDraft>(saved)
  // Track every saved change. Reset the draft only when it had no edits.
  if (!sameAgentRun(seen, saved)) {
    if (sameAgentRun(draft, seen)) setDraft(saved)
    setSeen(saved)
  }
  const dirty = !sameAgentRun(draft, saved)

  const handleSave = () => {
    updateAgent.mutate(
      { agentId: agent.id, patch: agentRunPatch(draft) },
      {
        onSuccess: () => toast.success(`${agent.name} settings saved`),
        onError: error => toast.error(`Failed to save settings: ${error}`),
      }
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-sm font-medium">Run configuration</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          New chats, task sessions, and wake-ups use these choices. Default
          keeps the backend and model a new chat would use.
        </p>
      </div>
      <AgentRunFields
        idPrefix="agent-settings"
        serverId={agent.serverId}
        value={draft}
        onChange={setDraft}
      />
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!dirty || updateAgent.isPending}>
          Save
        </Button>
      </div>
    </div>
  )
}
