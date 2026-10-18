import { Suspense, lazy, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  useAgentDetails,
  type AgentSummary,
  type AgentTask,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { formatRelative } from './AgentActivity'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

const KIND_LABELS: Record<string, string> = {
  schedule: 'Schedule',
  delegation: 'Follow-up',
  message: 'Agent request',
  approval: 'Approval',
}

const STATUS_STYLES: Record<string, string> = {
  running: 'text-primary',
  waiting: 'text-amber-600 dark:text-amber-400',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  done: 'text-muted-foreground',
}

/** Status text: "waiting" means the task waits for work it handed off. */
export function taskStatusLabel(status: string): string {
  return status === 'waiting' ? 'waiting for sessions' : status
}

function TaskRow({
  task,
  onOpen,
}: {
  task: AgentTask
  onOpen: (task: AgentTask) => void
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
        onClick={() => onOpen(task)}
      >
        <span className="min-w-0 flex-1 truncate text-foreground">
          {task.title}
        </span>
        <span className={cn('shrink-0 text-xs', STATUS_STYLES[task.status])}>
          {taskStatusLabel(task.status)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {KIND_LABELS[task.kind] ?? task.kind} ·{' '}
          {formatRelative(task.updatedAt)}
        </span>
      </button>
    </li>
  )
}

/** Background tasks of an agent; a task opens its own session. */
export function AgentTasks({
  agent,
  workdir,
}: {
  agent: AgentSummary
  workdir: string | undefined
}) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const [openTask, setOpenTask] = useState<AgentTask | null>(null)

  const handleOpen = (task: AgentTask) => {
    useChatStore
      .getState()
      .setActiveSession(agent.tasksWorktreeId, task.sessionId)
    setOpenTask(task)
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
      <p className="text-xs text-muted-foreground">
        Schedules, follow-ups and agent requests run here, apart from your chat.
        Finished tasks are archived after 3 days.
      </p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading tasks…</p>
      ) : data?.tasks.length ? (
        <ul className="space-y-0.5">
          {data.tasks.map(task => (
            <TaskRow key={task.id} task={task} onOpen={handleOpen} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No open tasks.</p>
      )}
      <Dialog
        open={openTask !== null && workdir !== undefined}
        onOpenChange={open => !open && setOpenTask(null)}
      >
        <DialogContent className="!fixed !inset-0 !translate-x-0 !translate-y-0 !w-screen !h-[100dvh] !max-w-none !max-h-none !rounded-none !p-0 sm:!inset-auto sm:!top-[50%] sm:!left-[50%] sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:!w-[90vw] sm:!max-w-[90vw] sm:!h-[90dvh] sm:!max-h-[90dvh] sm:!rounded-lg flex flex-col gap-0 overflow-hidden">
          {openTask && workdir && (
            <>
              <DialogHeader className="shrink-0 space-y-1 border-b px-4 py-3 pr-12 text-left">
                <DialogTitle className="truncate text-base">
                  {openTask.title}
                </DialogTitle>
                <DialogDescription className="flex flex-wrap items-center gap-x-2 text-xs">
                  <span className={STATUS_STYLES[openTask.status]}>
                    {taskStatusLabel(openTask.status)}
                  </span>
                  <span>
                    {KIND_LABELS[openTask.kind] ?? openTask.kind} · updated{' '}
                    {formatRelative(openTask.updatedAt)}
                  </span>
                </DialogDescription>
                {openTask.summary ? (
                  <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                    {openTask.summary}
                  </p>
                ) : null}
              </DialogHeader>
              <div className="relative flex min-h-0 flex-1 flex-col">
                <Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                      Loading task…
                    </div>
                  }
                >
                  <ChatWindow
                    key={openTask.sessionId}
                    isModal
                    worktreeId={agent.tasksWorktreeId}
                    worktreePath={workdir}
                  />
                </Suspense>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
