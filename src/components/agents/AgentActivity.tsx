import { useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { parseServerResourceKey } from '@/lib/server-resource'
import { useProjects, useWorktree } from '@/services/projects'
import {
  useAgentDetails,
  useAgentsList,
  useDecideAgentApproval,
  useRevertAgentChange,
  type AgentApproval,
  type AgentChange,
  type AgentDelegation,
  type AgentSummary,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { AgentQuestionCard } from './AgentQuestionCard'
import { useAgentsEnabledServers } from './agents-feature'
import {
  agentChangeActorLabel,
  agentChangeDetail,
  latestChangeIdForTarget,
} from './agent-changes'
import {
  AgentBadge,
  AgentEmpty,
  AgentList,
  AgentNotice,
  AgentSection,
  AgentTabBody,
  statusTone,
} from './agent-ui'

/** "5m ago" / "in 2h" for unix seconds. */
export function formatRelative(unixSeconds: number, now = Date.now()): string {
  const diff = Math.round(unixSeconds - now / 1000)
  const abs = Math.abs(diff)
  const value =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86_400
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86_400)}d`
  if (abs < 5) return 'now'
  return diff > 0 ? `in ${value}` : `${value} ago`
}

/** One line that says what an approval will do, with names, not IDs. */
export function describeApproval(
  approval: AgentApproval,
  targetName?: string
): string {
  const args = approval.args ?? {}
  const text = (key: string) =>
    typeof args[key] === 'string' && args[key] ? (args[key] as string) : ''
  if (
    approval.tool === 'agent_update' ||
    approval.tool === 'agent_delete' ||
    approval.tool === 'agent_revert'
  ) {
    const who = text('targetName') || 'another agent'
    const verb =
      approval.tool === 'agent_delete'
        ? 'Delete agent'
        : approval.tool === 'agent_revert'
          ? 'Undo the last change to'
          : 'Update agent'
    return `${verb} ${who}`
  }
  // A deleted worktree has no name to look up: fall back to its folder name
  const target =
    targetName ?? text('worktreePath').split(/[\\/]/).filter(Boolean).pop()
  const labels: Record<string, [string, string]> = {
    delete_worktree: ['Delete worktree', 'Delete a worktree'],
    permanently_delete_worktree: [
      'Permanently delete worktree',
      'Permanently delete a worktree',
    ],
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
  const run = (approve: boolean) =>
    decide.mutate(
      { agentId: approval.agentId, approvalId: approval.id, approve },
      {
        onSuccess: result =>
          result.status === 'failed'
            ? toast.error(`It failed: ${result.result}`)
            : toast.success(approve ? 'Approved' : 'Denied'),
        onError: e => toast.error(`Failed: ${e}`),
      }
    )
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

function ApprovalRow({ approval }: { approval: AgentApproval }) {
  const decide = useDecide(approval)
  const targetName = useTargetName(approval)
  const run = decide.run
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          {describeApproval(approval, targetName)}
        </p>
        {approval.status !== 'pending' && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AgentBadge tone={statusTone(approval.status)}>
              {approval.status}
            </AgentBadge>
            {approval.result ? (
              <span
                className={cn(
                  'truncate',
                  approval.status === 'failed' && 'text-destructive'
                )}
              >
                {approval.result}
              </span>
            ) : null}
          </p>
        )}
      </div>
      {approval.status === 'pending' && (
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => run(false)}
          >
            Deny
          </Button>
          <Button
            size="sm"
            disabled={decide.isPending}
            onClick={() => run(true)}
          >
            Approve
          </Button>
        </div>
      )}
    </li>
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
  const agents = useAgentsList(useAgentsEnabledServers()).data ?? []
  const agent = agents.find(
    a => a.worktreeId === worktreeId || a.tasksWorktreeId === worktreeId
  )
  const { data } = useAgentDetails(agent?.id ?? null)
  const approval = data?.approvals.find(a => a.id === approvalId)
  if (!approval) return null
  return <ApprovalQuestion approval={approval} />
}

function ApprovalQuestion({ approval }: { approval: AgentApproval }) {
  const decide = useDecide(approval)
  const targetName = useTargetName(approval)
  const pending = approval.status === 'pending'
  return (
    <AgentQuestionCard
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
    >
      {approval.status === 'failed' && (
        <p className="text-xs text-destructive">
          It failed: {approval.result ?? 'unknown error'}
        </p>
      )}
    </AgentQuestionCard>
  )
}

/** Pending approvals above the agent chat. */
export function PendingApprovals({ agentId }: { agentId: string }) {
  const { data } = useAgentDetails(agentId)
  const pending = data?.approvals.filter(a => a.status === 'pending') ?? []
  if (pending.length === 0) return null
  return (
    <div className="shrink-0 border-b bg-amber-500/5 px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          The agent waits for your approval
        </p>
        <AgentList className="bg-background">
          {pending.map(approval => (
            <ApprovalRow key={approval.id} approval={approval} />
          ))}
        </AgentList>
      </div>
    </div>
  )
}

function DelegationRow({ delegation }: { delegation: AgentDelegation }) {
  // Agent sessions use reserved IDs (also when scoped to a remote server)
  const isAgentSession = (
    parseServerResourceKey(delegation.worktreeId)?.resourceId ??
    delegation.worktreeId
  ).startsWith('__')
  const { data: worktree } = useWorktree(
    isAgentSession ? null : delegation.worktreeId
  )

  const open = useCallback(() => {
    if (!worktree) return
    const { selectProject, selectWorktree } = useProjectsStore.getState()
    selectProject(worktree.project_id)
    selectWorktree(worktree.id)
    const chat = useChatStore.getState()
    chat.registerWorktreePath(worktree.id, worktree.path)
    chat.clearActiveWorktree()
    chat.setActiveSession(worktree.id, delegation.sessionId)
    const ui = useUIStore.getState()
    ui.markWorktreeForAutoOpenSession(worktree.id, delegation.sessionId)
    // Leave the Agents page so the project canvas can open the session
    ui.setRailSection('workspace')
  }, [worktree, delegation.sessionId])

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          <span className="truncate text-foreground">
            {isAgentSession
              ? 'Agent request'
              : (worktree?.name ?? delegation.worktreeId)}
          </span>
          <AgentBadge tone={statusTone(delegation.status)}>
            {delegation.status}
          </AgentBadge>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelative(delegation.updatedAt)}
          </span>
        </p>
        {delegation.lastSummary ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {delegation.lastSummary}
          </p>
        ) : null}
      </div>
      {worktree && (
        <Button size="sm" variant="ghost" onClick={open}>
          Open
        </Button>
      )}
    </li>
  )
}

function ChangeRow({
  change,
  canRevert,
  agentId,
}: {
  change: AgentChange
  canRevert: boolean
  agentId: string
}) {
  const revert = useRevertAgentChange()
  const detail = agentChangeDetail(change)
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{change.summary}</p>
        <p className="text-xs text-muted-foreground">
          {agentChangeActorLabel(change.actorAgentId)} ·{' '}
          {formatRelative(change.createdAt)}
        </p>
        {detail ? (
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      {canRevert && (
        <Button
          size="sm"
          variant="outline"
          disabled={revert.isPending}
          onClick={() => {
            const id = toast.loading('Reverting change…')
            revert.mutate(
              { agentId, changeId: change.id },
              {
                onSuccess: () => toast.success('Change reverted', { id }),
                onError: error =>
                  toast.error(`Failed to revert: ${error}`, { id }),
              }
            )
          }}
        >
          Revert
        </Button>
      )}
    </li>
  )
}

function Section({
  title,
  description,
  empty,
  children,
}: {
  title: string
  description: string
  empty: string
  children: React.ReactNode[]
}) {
  return (
    <AgentSection
      title={title}
      count={children.length}
      description={description}
    >
      {children.length > 0 ? (
        <AgentList>{children}</AgentList>
      ) : (
        <AgentEmpty title={empty} />
      )}
    </AgentSection>
  )
}

/** Approvals and followed sessions of an agent. */
export function AgentActivity({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading activity…
      </div>
    )
  }
  const pending = data.approvals.filter(a => a.status === 'pending')
  const decided = data.approvals.filter(a => a.status !== 'pending')
  return (
    <AgentTabBody>
      {agent.budgetReached && (
        <AgentNotice>
          Hourly limit reached ({agent.maxWakesPerHour} wake-ups). Updates wait
          until the next hour.
        </AgentNotice>
      )}
      <Section
        title="Approvals"
        description="Destructive actions the agent asked you to allow."
        empty="No approval requests."
      >
        {[...pending, ...decided].map(approval => (
          <ApprovalRow key={approval.id} approval={approval} />
        ))}
      </Section>
      <Section
        title="Followed sessions"
        description="Project sessions the agent started or watches."
        empty="The agent does not follow any session yet."
      >
        {data.delegations.map(delegation => (
          <DelegationRow key={delegation.id} delegation={delegation} />
        ))}
      </Section>
      <Section
        title="Changes"
        description="Edits to agents made through self-management. The latest change per agent can be reverted."
        empty="No self-management changes yet."
      >
        {data.changes.map(change => (
          <ChangeRow
            key={change.id}
            change={change}
            agentId={agent.id}
            canRevert={
              change.id ===
              latestChangeIdForTarget(
                data.changes,
                parseServerResourceKey(agent.id)?.resourceId ?? agent.id
              )
            }
          />
        ))}
      </Section>
    </AgentTabBody>
  )
}
