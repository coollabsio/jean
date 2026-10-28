import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateAgent, type AgentSummary } from '@/services/agents'
import {
  agentRunPatch,
  draftFromAgent,
  sameAgentRun,
  type AgentRunDraft,
} from './agent-config'
import { AgentConnectors } from './AgentConnectors'
import { AgentRunFields } from './AgentRunFields'
import { AgentPanel, AgentSection, AgentTabBody, SaveFooter } from './agent-ui'
import { useSavedDraft } from './use-saved-draft'

const sameText = (left: string, right: string) => left === right

/** Role prompt, run configuration, and connectors of an existing agent. */
export function AgentSettings({ agent }: { agent: AgentSummary }) {
  const updateAgent = useUpdateAgent()
  const saved = draftFromAgent(agent)
  const [draft, setDraft] = useSavedDraft<AgentRunDraft>(saved, sameAgentRun)
  const dirty = !sameAgentRun(draft, saved)
  const [rolePrompt, setRolePrompt] = useSavedDraft(agent.rolePrompt, sameText)
  const roleDirty = rolePrompt.trim() !== agent.rolePrompt

  const handleSaveRole = () => {
    updateAgent.mutate(
      { agentId: agent.id, patch: { rolePrompt } },
      {
        onSuccess: () => toast.success(`${agent.name} role prompt saved`),
        onError: error => toast.error(`Failed to save role prompt: ${error}`),
      }
    )
  }

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
    <AgentTabBody>
      <AgentSection
        title="Role prompt"
        description="Instructions the agent follows in every chat and wake-up."
      >
        <AgentPanel>
          <Textarea
            value={rolePrompt}
            rows={8}
            aria-label="Role prompt"
            onChange={e => setRolePrompt(e.target.value)}
          />
          <SaveFooter
            dirty={roleDirty}
            pending={updateAgent.isPending}
            onDiscard={() => setRolePrompt(agent.rolePrompt)}
            onSave={handleSaveRole}
          />
        </AgentPanel>
      </AgentSection>
      <AgentSection
        title="Run configuration"
        description="New chats, runs, and wake-ups use these choices."
      >
        <AgentPanel>
          <AgentRunFields
            idPrefix="agent-settings"
            serverId={agent.serverId}
            value={draft}
            onChange={setDraft}
          />
          <SaveFooter
            dirty={dirty}
            pending={updateAgent.isPending}
            onDiscard={() => setDraft(saved)}
            onSave={handleSave}
          />
        </AgentPanel>
      </AgentSection>
      <AgentConnectors
        agent={agent}
        pendingBackend={draft.backend !== saved.backend ? draft.backend : null}
      />
    </AgentTabBody>
  )
}
