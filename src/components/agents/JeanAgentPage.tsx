import { Suspense, lazy } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { JeanAgentIcon } from '@/components/icons/JeanAgentIcon'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

/** Reserved worktree ID for Jean agent sessions (matches Rust `JEAN_AGENT_WORKTREE_ID`). */
export const JEAN_AGENT_WORKTREE_ID = '__jean_agent__'

const LOADING = (
  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
    Calling Jean…
  </div>
)

/** Agents page: Jean, the coordinator that manages all projects. */
export function JeanAgentPage() {
  const { data: workdir, error } = useQuery({
    queryKey: ['jean-agent', 'workdir'],
    queryFn: () => invoke<string>('get_jean_agent_workdir'),
    staleTime: Infinity,
  })

  return (
    <div className="flex h-full min-h-0 w-full flex-col font-sans">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <JeanAgentIcon className="size-9 shrink-0" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight text-foreground">
            Jean
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            The boss. Coordinates all your projects.
          </p>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {error ? (
          <div
            className="flex flex-1 items-center justify-center text-sm text-destructive"
            role="alert"
          >
            Jean is unavailable: {String(error)}
          </div>
        ) : workdir ? (
          <Suspense fallback={LOADING}>
            <ChatWindow
              isModal
              worktreeId={JEAN_AGENT_WORKTREE_ID}
              worktreePath={workdir}
            />
          </Suspense>
        ) : (
          LOADING
        )}
      </div>
    </div>
  )
}
