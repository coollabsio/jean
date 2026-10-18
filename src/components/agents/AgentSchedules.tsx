import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  useAgentDetails,
  useCancelAgentSchedule,
  type AgentSchedule,
  type AgentSummary,
} from '@/services/agents'
import { formatRelative } from './AgentActivity'

/** "every 30m" / "every 2h" / "every 1d" for a repeat interval. */
export function formatInterval(everySecs: number): string {
  const minutes = Math.round(everySecs / 60)
  if (minutes % 1440 === 0) return `every ${minutes / 1440}d`
  if (minutes % 60 === 0) return `every ${minutes / 60}h`
  return `every ${minutes}m`
}

function ScheduleRow({
  schedule,
  agentId,
}: {
  schedule: AgentSchedule
  agentId: string
}) {
  const cancel = useCancelAgentSchedule()
  return (
    <li className="flex items-start gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="truncate text-foreground">{schedule.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {schedule.everySecs
              ? `${formatInterval(schedule.everySecs)}, next ${formatRelative(schedule.nextRunAt)}`
              : `once, ${formatRelative(schedule.nextRunAt)}`}
            {schedule.lastRunAt
              ? ` · last ran ${formatRelative(schedule.lastRunAt)}`
              : ''}
          </span>
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {schedule.prompt}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={cancel.isPending}
        onClick={() =>
          cancel.mutate(
            { agentId, scheduleId: schedule.id },
            { onError: e => toast.error(`Failed: ${e}`) }
          )
        }
      >
        Cancel
      </Button>
    </li>
  )
}

/** Active schedules of an agent. Each run starts a task (see Tasks). */
export function AgentSchedules({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
      <p className="text-xs text-muted-foreground">
        Each run starts a background task. Ask the agent in the chat to create
        or change schedules.
      </p>
      {agent.paused && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          The agent is stopped. Schedules do not run until you resume it.
        </p>
      )}
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading schedules…</p>
      ) : data?.schedules.length ? (
        <ul className="space-y-2">
          {data.schedules.map(schedule => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              agentId={agent.id}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No schedules.</p>
      )}
    </div>
  )
}
