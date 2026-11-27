import type { QueryClient } from '@tanstack/react-query'
import { scheduleIdleWork } from '@/lib/idle'
import { worktreeFilesQuery } from '@/services/files'
import { skillQueries } from '@/services/skills'

const QUIET_CHECK_MS = 1000
/** Load anyway after this many checks, in case a query never settles. */
const MAX_QUIET_CHECKS = 10

/**
 * The `@` and `/` popovers load their lists when they open. Load them earlier,
 * once the page is idle and no other request is in flight, so the first open
 * shows them at once. Lists already cached are not loaded again.
 */
export function prefetchInputListsWhenQuiet(
  queryClient: QueryClient,
  worktreeId: string | null | undefined,
  worktreePath: string
): () => void {
  let checks = 0
  let cancel = scheduleIdleWork(check, 3000)

  function check() {
    if (queryClient.isFetching() > 0 && ++checks < MAX_QUIET_CHECKS) {
      const timer = window.setTimeout(() => {
        cancel = scheduleIdleWork(check, 3000)
      }, QUIET_CHECK_MS)
      cancel = () => window.clearTimeout(timer)
      return
    }
    const ensure = (load: () => Promise<unknown>) =>
      void load().catch(() => undefined)
    ensure(() =>
      queryClient.ensureQueryData(
        worktreeFilesQuery(worktreePath, {
          worktreeId: worktreeId ?? undefined,
        })
      )
    )
    ensure(() =>
      queryClient.ensureQueryData(
        skillQueries.claudeSkills(worktreeId, worktreePath)
      )
    )
    ensure(() =>
      queryClient.ensureQueryData(
        skillQueries.claudeCommands(worktreeId, worktreePath)
      )
    )
    ensure(() =>
      queryClient.ensureQueryData(
        skillQueries.codexSkills(worktreeId, worktreePath)
      )
    )
    ensure(() => queryClient.ensureQueryData(skillQueries.opencodeSkills()))
    ensure(() => queryClient.ensureQueryData(skillQueries.cursorSkills()))
    ensure(() => queryClient.ensureQueryData(skillQueries.piSkills()))
    ensure(() => queryClient.ensureQueryData(skillQueries.commandcodeSkills()))
    ensure(() => queryClient.ensureQueryData(skillQueries.grokSkills()))
    ensure(() => queryClient.ensureQueryData(skillQueries.pluginSkills()))
  }

  return () => cancel()
}
