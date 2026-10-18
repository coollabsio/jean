import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  useAutoFixStatus,
  useAutoFixPreview,
  useRequestAutoFixScan,
  useClearAutoFixFailures,
  useUpdateProjectSettings,
} from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { invokeForServer } from '@/lib/transport'
import { parseServerResourceKey } from '@/lib/server-resource'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { openExternal, preOpenWindow } from '@/lib/platform'
import type { Project, Worktree } from '@/types/projects'
import type { SessionCardData } from '@/components/chat/session-card-utils'
import {
  formatRobotTime,
  getRobotStatus,
  getRobotWorktreeState,
} from './mr-robot-state'

export interface RobotWorktree {
  worktree: Worktree
  cards: SessionCardData[]
}

export function MrRobotProgress({
  row,
  onOpen,
}: {
  row: RobotWorktree
  onOpen: (worktree: Worktree, card?: SessionCardData) => void
}) {
  const state = getRobotWorktreeState(row.worktree, row.cards)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2 text-xs">
      <span
        className={
          state.needsAttention ? 'text-warning' : 'text-muted-foreground'
        }
      >
        {row.worktree.issue_number != null &&
          `#${row.worktree.issue_number} · `}
        {state.label}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs"
        onClick={() => {
          if (state.action === 'Open PR' && row.worktree.pr_url) {
            void openExternal(row.worktree.pr_url).catch(error =>
              toast.error(String(error))
            )
          } else onOpen(row.worktree, state.card)
        }}
      >
        {state.action}
      </Button>
    </div>
  )
}

export function MrRobotPanel({
  project,
  rows,
}: {
  project: Project
  rows: RobotWorktree[]
}) {
  const enabled = project.auto_fix_settings?.enabled ?? false
  const query = useAutoFixStatus(project.id, !project.offline)
  const scan = useRequestAutoFixScan()
  const clear = useClearAutoFixFailures()
  const update = useUpdateProjectSettings()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now() / 1000)
  const preview = useAutoFixPreview(project.id, previewOpen && !project.offline)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 10_000)
    return () => clearInterval(timer)
  }, [])
  const status = query.data
  const states = rows.map(row => getRobotWorktreeState(row.worktree, row.cards))
  const label = getRobotStatus(enabled, status, states, now)
  const starting =
    status?.startingIssues.filter(
      number => !rows.some(row => row.worktree.issue_number === number)
    ).length ?? 0
  const active = states.filter(state => state.active).length + starting
  const attention =
    states.filter(state => state.needsAttention).length +
    (status?.failedIssues.filter(
      issue =>
        !rows.some(
          row =>
            row.worktree.issue_number === issue.issueNumber &&
            getRobotWorktreeState(row.worktree, row.cards).needsAttention
        )
    ).length ?? 0)
  const configure = () =>
    useProjectsStore.getState().openProjectSettings(project.id, 'auto-fix')
  const toggle = async () => {
    if (!project.auto_fix_settings) {
      configure()
      return
    }
    const id = toast.loading(
      enabled ? 'Pausing new work...' : 'Resuming new work...'
    )
    try {
      await update.mutateAsync({
        projectId: project.id,
        autoFixSettings: { ...project.auto_fix_settings, enabled: !enabled },
      })
      toast.success(enabled ? 'New work paused' : 'New work enabled', { id })
    } catch (error) {
      toast.error('Cannot change Mr. Robot settings', {
        id,
        description: String(error),
      })
    }
  }
  const openIssue = async (number: number) => {
    const window = preOpenWindow()
    try {
      const owner = parseServerResourceKey(project.id)
      const issue = await invokeForServer<{ url: string }>(
        owner?.serverId ?? LOCAL_SERVER_ID,
        'get_github_issue',
        { projectPath: project.path, issueNumber: number }
      )
      if (!issue.url) throw new Error('Issue URL is not available')
      await openExternal(issue.url, window)
    } catch (error) {
      window?.close()
      toast.error('Cannot open issue', { description: String(error) })
    }
  }
  return (
    <section
      aria-label="Mr. Robot status"
      className="mx-4 mt-4 space-y-3 rounded-lg border bg-muted/20 p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">Mr. Robot</h2>
          <Badge variant="outline">{label}</Badge>
          <span className="text-xs text-muted-foreground">
            {active} active · {attention} need attention · {rows.length}{' '}
            worktrees
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              !enabled ||
              project.offline ||
              scan.isPending ||
              query.isPending ||
              Boolean(status?.scanning) ||
              status?.activeNow === false ||
              Boolean(status?.rateLimitedUntil && status.rateLimitedUntil > now)
            }
            onClick={() => scan.mutate(project.id)}
          >
            Scan now
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={project.offline || update.isPending}
            onClick={() => void toggle()}
          >
            {!project.auto_fix_settings
              ? 'Set up'
              : enabled
                ? 'Pause new work'
                : 'Resume new work'}
          </Button>
          {project.auto_fix_settings && (
            <Button size="sm" variant="ghost" onClick={configure}>
              Settings
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Pause prevents new scans and automatic plan approval. Active sessions
        continue.
      </p>
      {query.isError ? (
        <div className="flex flex-wrap items-center gap-2 text-destructive">
          <span>Cannot load status: {String(query.error)}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry status
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>Last scan: {formatRobotTime(status?.lastScanAt, now)}</span>
          <span>
            Next scan:{' '}
            {!enabled
              ? 'Off'
              : status?.activeNow === false
                ? 'During active hours on the server'
                : status?.nextScanAt === 0
                  ? 'Next scheduler tick'
                  : formatRobotTime(status?.nextScanAt, now)}
          </span>
          {status?.lastScanSummary && <span>{status.lastScanSummary}</span>}
        </div>
      )}
      {status?.rateLimitedUntil != null && status.rateLimitedUntil > now && (
        <p className="text-xs text-warning">
          GitHub rate limit resets{' '}
          {formatRobotTime(status.rateLimitedUntil, now)}. Scan now cannot
          bypass this limit.
        </p>
      )}
      {status?.lastError && (
        <p className="break-words text-xs text-destructive">
          {status.lastError.message}
        </p>
      )}
      {Boolean(status?.failedIssues.length) && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-medium">Failed starts</h3>
            <Button
              size="sm"
              variant="outline"
              disabled={project.offline || clear.isPending}
              onClick={() => clear.mutate(project.id)}
            >
              Retry failed issues
            </Button>
          </div>
          <ul className="space-y-1 text-xs">
            {status?.failedIssues.map(issue => (
              <li key={issue.issueNumber} className="break-words">
                <button
                  type="button"
                  className="underline"
                  onClick={() => void openIssue(issue.issueNumber)}
                >
                  #{issue.issueNumber}
                </button>{' '}
                ·{' '}
                {issue.gaveUp
                  ? 'Retry required'
                  : `${issue.attempts}/3 attempts`}{' '}
                · {issue.error}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Retry clears failed starts. They can start on the next scan while
            Mr. Robot is enabled.
          </p>
        </div>
      )}
      {rows.length === 0 && (
        <div className="space-y-1 rounded-md bg-background/60 p-3">
          <h3 className="text-sm font-medium">
            {!enabled
              ? 'Mr. Robot is off'
              : status?.activeNow === false
                ? 'Waiting for active hours'
                : status?.scanning
                  ? 'Checking GitHub issues'
                  : status?.lastScanAt
                    ? 'No automation worktrees yet'
                    : 'Waiting for the first scan'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {!enabled
              ? 'Set up or resume Mr. Robot to plan matching GitHub issues.'
              : 'Preview issues to check labels and capacity. Mr. Robot worktrees and sessions stay in this tab.'}
          </p>
        </div>
      )}
      <div className="border-t pt-3">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={previewOpen}
          disabled={!project.auto_fix_settings || project.offline}
          onClick={() => setPreviewOpen(!previewOpen)}
        >
          {previewOpen ? 'Hide issue preview' : 'Preview issues'}
        </Button>
        {previewOpen && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Open issues only, up to 1,000. Preview does not start work.
                Candidates still depend on active hours, enabled state, and
                available capacity.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={preview.isFetching}
                onClick={() => void preview.refetch()}
              >
                Refresh preview
              </Button>
            </div>
            {preview.isPending ? (
              <p className="text-xs">Loading issues...</p>
            ) : preview.isError ? (
              <p className="text-xs text-destructive">
                {String(preview.error)}
              </p>
            ) : preview.data?.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No open GitHub issues found.
              </p>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto text-xs">
                {preview.data?.map(issue => (
                  <li
                    key={issue.issueNumber}
                    className="flex flex-wrap items-center gap-2 rounded-md bg-background/60 p-2"
                  >
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void openIssue(issue.issueNumber)}
                    >
                      #{issue.issueNumber}
                    </button>
                    <Badge variant="outline">{issue.reason}</Badge>
                    <span className="break-words text-muted-foreground">
                      {issue.labels.join(', ') || 'No labels'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-xs font-medium">
          Recent activity
        </summary>
        <p className="my-2 text-xs text-muted-foreground">
          Latest 30 events on this server. History resets when the server
          restarts.
        </p>
        {status?.activity?.length ? (
          <ul className="max-h-48 space-y-2 overflow-y-auto text-xs">
            {status.activity.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="break-words">
                <span className="text-muted-foreground">
                  {formatRobotTime(entry.at, now)} ·{' '}
                </span>
                {entry.issueNumber != null && (
                  <>
                    <button
                      type="button"
                      className="underline"
                      onClick={() => {
                        if (entry.issueNumber != null)
                          void openIssue(entry.issueNumber)
                      }}
                    >
                      #{entry.issueNumber}
                    </button>{' '}
                    ·{' '}
                  </>
                )}
                {entry.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No activity recorded yet.
          </p>
        )}
      </details>
    </section>
  )
}
