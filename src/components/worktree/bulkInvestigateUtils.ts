import { toast } from 'sonner'
import { listen } from '@/lib/transport'
import type {
  Worktree,
  WorktreeCreatedEvent,
  WorktreeCreateErrorEvent,
} from '@/types/projects'

const WORKTREE_READY_TIMEOUT_MS = 120_000

/** Shared toast summary after a multi-select bulk investigate run. */
export function reportBulkInvestigateResults(
  toastId: string | number,
  succeeded: number,
  failed: number,
  nounSingular: string,
  nounPlural: string
): void {
  const noun = (n: number) => (n === 1 ? nounSingular : nounPlural)

  if (failed === 0) {
    toast.success(
      `Investigating ${succeeded} ${noun(succeeded)} in background`,
      { id: toastId }
    )
  } else if (succeeded === 0) {
    toast.error(`Failed to start investigation for ${failed} ${noun(failed)}`, {
      id: toastId,
    })
  } else {
    toast.warning(
      `Investigating ${succeeded} in background; ${failed} failed`,
      { id: toastId }
    )
  }
}

/**
 * Starts a bulk investigation one item at a time and shows the progress in a
 * loading toast. When an item creates a worktree, the next item starts only
 * after the backend reports that worktree as created (or failed), so a large
 * selection does not set up many worktrees and sessions at the same time.
 */
export async function runBulkInvestigation<T>(
  items: T[],
  nounSingular: string,
  nounPlural: string,
  start: (item: T) => Promise<Worktree>
): Promise<void> {
  const total = items.length
  const noun = total === 1 ? nounSingular : nounPlural
  const toastId = toast.loading(`Starting investigation of ${total} ${noun}…`)

  // Listen before the first create so no created/error event is missed.
  const outcomes = new Map<string, string | null>()
  const waiters = new Map<string, (error: string | null) => void>()
  const settle = (id: string, error: string | null) => {
    const waiter = waiters.get(id)
    if (waiter) {
      waiters.delete(id)
      waiter(error)
    } else {
      outcomes.set(id, error)
    }
  }
  const unlisteners = await Promise.all([
    listen<WorktreeCreatedEvent>('worktree:created', event =>
      settle(event.payload.worktree.id, null)
    ),
    listen<WorktreeCreateErrorEvent>('worktree:error', event =>
      settle(event.payload.id, event.payload.error)
    ),
  ])

  const waitForWorktree = async (id: string) => {
    const error = outcomes.has(id)
      ? (outcomes.get(id) ?? null)
      : await new Promise<string | null>(resolve => {
          // On timeout, go on: the backend still owns the creation.
          const timeout = setTimeout(() => {
            waiters.delete(id)
            resolve(null)
          }, WORKTREE_READY_TIMEOUT_MS)
          waiters.set(id, outcome => {
            clearTimeout(timeout)
            resolve(outcome)
          })
        })
    if (error) throw new Error(error)
  }

  let succeeded = 0
  try {
    for (const [index, item] of items.entries()) {
      if (total > 1) {
        toast.loading(
          `Starting investigation ${index + 1} of ${total} ${noun}…`,
          { id: toastId }
        )
      }
      try {
        const worktree = await start(item)
        await waitForWorktree(worktree.id)
        succeeded++
      } catch {
        // Counted as failed in the summary toast.
      }
    }
  } finally {
    for (const unlisten of unlisteners) unlisten()
  }

  reportBulkInvestigateResults(
    toastId,
    succeeded,
    total - succeeded,
    nounSingular,
    nounPlural
  )
}
