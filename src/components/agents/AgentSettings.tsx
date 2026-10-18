import { toast } from 'sonner'
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

/** Run configuration and connectors of an existing agent. */
export function AgentSettings({ agent }: { agent: AgentSummary }) {
  const updateAgent = useUpdateAgent()
  const saved = draftFromAgent(agent)
  const [draft, setDraft] = useSavedDraft<AgentRunDraft>(saved, sameAgentRun)
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
    <AgentTabBody>
      <AgentSection
        title="Run configuration"
        description="New chats, task sessions, and wake-ups use these choices."
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
