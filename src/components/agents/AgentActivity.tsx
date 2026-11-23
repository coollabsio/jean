import { toast } from 'sonner'
import { useProjects, useWorktree } from '@/services/projects'
import {
  useAgentDetails,
  useDecideAgentApproval,
  type AgentApproval,
} from '@/services/agents'
import { AgentQuestionCard } from './AgentQuestionCard'
import { coordinatorAgentIdForWorktree } from './agents'

/** One line that says what an approval will do, with names, not IDs. */
export function describeApproval(
  approval: AgentApproval,
  targetName?: string
): string {
  const args = approval.args ?? {}
  const text = (key: string) =>
    typeof args[key] === 'string' && args[key] ? (args[key] as string) : ''
  if (approval.tool === 'set_connector') {
    const verb = text('action') === 'disable' ? 'Disable' : 'Enable'
    const scope = text('scope')
    const where =
      scope === 'global'
        ? 'for all sessions'
        : scope === 'project'
          ? targetName
            ? `for project ${targetName}`
            : 'for a project'
          : 'for an agent'
    return `${verb} MCP server ${text('backend')}:${text('name')} ${where}`
  }
  // A deleted worktree has no name to look up: fall back to its folder name
  const target =
    targetName ?? text('worktreePath').split(/[\\/]/).filter(Boolean).pop()
  const labels: Record<string, [string, string]> = {
    delete_worktree: ['Delete worktree', 'Delete a worktree'],
    push_worktree: ['Push worktree', 'Push a worktree'],
    merge_pull_request: [
      'Merge the pull request of',
      'Merge the pull request of a worktree',
    ],
    create_pull_request: [
      'Create a pull request for',
      'Create a pull request for a worktree',
    ],
    remove_project: ['Remove project', 'Remove a project'],
  }
  const label = labels[approval.tool]
  if (!label) return approval.tool.replace(/_/g, ' ')
  return target ? `${label[0]} ${target}` : label[1]
}

const APPROVE = 'Approve'
const DENY = 'Deny'

function useDecide(approval: AgentApproval) {
  const decide = useDecideAgentApproval()
  const run = (approve: boolean) => {
    // Approving runs the tool before the reply comes back (a pull request can take a while)
    const id = toast.loading(approve ? 'Approved. Running…' : 'Denying…')
    decide.mutate(
      { agentId: approval.agentId, approvalId: approval.id, approve },
      {
        onSuccess: result =>
          result.status === 'failed'
            ? toast.error(`It failed: ${result.result}`, { id })
            : toast.success(approve ? 'Approved' : 'Denied', { id }),
        onError: e => toast.error(`Failed: ${e}`, { id }),
      }
    )
  }
  return { run, isPending: decide.isPending }
}

/** Name of the worktree or project an approval acts on, if it still exists. */
function useTargetName(approval: AgentApproval): string | undefined {
  const { data: worktree } = useWorktree(
    (approval.args?.worktreeId as string | undefined) ?? null
  )
  const { data: projects = [] } = useProjects()
  const projectId = approval.args?.projectId as string | undefined
  return (
    worktree?.name ??
    (projectId ? projects.find(p => p.id === projectId)?.name : undefined)
  )
}

/** Approval request inside the agent chat, with its current status. */
export function AgentApprovalInline({
  approvalId,
  worktreeId,
}: {
  approvalId: number
  /** Worktree of the session that asked for approval */
  worktreeId: string | null | undefined
}) {
  const { data } = useAgentDetails(coordinatorAgentIdForWorktree(worktreeId))
  const approval = data?.approvals.find(a => a.id === approvalId)
  if (!approval) return null
  return <ApprovalQuestion approval={approval} />
}

function ApprovalQuestion({ approval }: { approval: AgentApproval }) {
  const decide = useDecide(approval)
  const targetName = useTargetName(approval)
  const pending = approval.status === 'pending'
  return (
    <>
      <AgentQuestionCard
        id={`approval-${approval.id}`}
        question={{
          question: `${describeApproval(approval, targetName)}?`,
          options: [APPROVE, DENY],
          multiple: false,
        }}
        answer={
          pending ? undefined : approval.status === 'denied' ? DENY : APPROVE
        }
        disabled={decide.isPending}
        onSend={answer => decide.run(answer === APPROVE)}
      />
      {decide.isPending && (
        <p className="text-xs text-muted-foreground">Running…</p>
      )}
      {approval.status === 'failed' && (
        <p className="text-xs text-destructive">
          It failed: {approval.result ?? 'unknown error'}
        </p>
      )}
    </>
  )
}
