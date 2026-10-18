import { Suspense, lazy, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  useAgentDetails,
  type AgentSummary,
  type AgentTask,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { formatRelative } from './AgentActivity'
import { taskKindLabel } from './subagent-types'
import {
  AgentBadge,
  AgentEmpty,
  AgentList,
  AgentLoading,
  AgentSection,
  AgentTabBody,
  statusTone,
} from './agent-ui'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

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

/** Running and waiting tasks first; finished ones apart. Order is kept. */
export function groupTasks(tasks: AgentTask[]): {
  active: AgentTask[]
  finished: AgentTask[]
} {
  const isActive = (task: AgentTask) =>
    task.status === 'running' || task.status === 'waiting'
  return {
    active: tasks.filter(isActive),
    finished: tasks.filter(task => !isActive(task)),
  }
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
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
        onClick={() => onOpen(task)}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{task.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {taskKindLabel(task.kind, task.subagentTypeName)} · updated{' '}
            {formatRelative(task.updatedAt)}
          </p>
          {task.summary ? (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/80">
              {task.summary}
            </p>
          ) : null}
        </div>
        <AgentBadge tone={statusTone(task.status)} className="mt-0.5">
          {taskStatusLabel(task.status)}
        </AgentBadge>
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

  const { active, finished } = groupTasks(data?.tasks ?? [])

  return (
    <AgentTabBody>
      {isLoading ? (
        <AgentLoading label="Loading tasks…" />
      ) : active.length === 0 && finished.length === 0 ? (
        <AgentSection
          title="Tasks"
          description="Routines, follow-ups, and agent requests run here, apart from your chat. Finished tasks are archived after 3 days."
        >
          <AgentEmpty title="No tasks yet." />
        </AgentSection>
      ) : (
        <>
          <AgentSection
            title="Active"
            count={active.length}
            description="Routines, follow-ups, and agent requests run here, apart from your chat. Open a task to see its session."
          >
            {active.length ? (
              <AgentList>
                {active.map(task => (
                  <TaskRow key={task.id} task={task} onOpen={handleOpen} />
                ))}
              </AgentList>
            ) : (
              <AgentEmpty title="Nothing running right now." />
            )}
          </AgentSection>
          {finished.length > 0 && (
            <AgentSection
              title="Finished"
              count={finished.length}
              description="Archived after 3 days."
            >
              <AgentList>
                {finished.map(task => (
                  <TaskRow key={task.id} task={task} onOpen={handleOpen} />
                ))}
              </AgentList>
            </AgentSection>
          )}
        </>
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
                    {taskKindLabel(openTask.kind, openTask.subagentTypeName)} ·
                    updated {formatRelative(openTask.updatedAt)}
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
    </AgentTabBody>
  )
}
