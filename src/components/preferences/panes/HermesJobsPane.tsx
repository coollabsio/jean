/**
 * Hermes Jobs panel (product surface A): list / lifecycle / last output.
 * Hermes gateway owns scheduling; Jean is the control plane + worktree UX.
 */

import { useMemo, useState } from 'react'
import {
  CalendarClock,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  FileText,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useHermesJobs,
  useHermesJobAction,
  useHermesJobOutput,
  useHermesStatus,
  useStartHermesGateway,
} from '@/services/hermes-cli'
import { useProjects } from '@/services/projects'
import { cn } from '@/lib/utils'
import type { HermesJob } from '@/types/hermes-cli'

export function HermesJobsPane({
  embedded = false,
}: {
  /** When true, omit the page header (used inside HermesPane). */
  embedded?: boolean
} = {}) {
  const [includeDisabled, setIncludeDisabled] = useState(true)
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

  const { data: projects = [] } = useProjects()
  const status = useHermesStatus()
  const startGateway = useStartHermesGateway()
  const jobAction = useHermesJobAction()

  const { data: jobs = [], isLoading, isFetching, refetch, isError, error } =
    useHermesJobs({
      includeDisabled,
      projectId: projectFilter === 'all' ? null : projectFilter,
      refetchInterval: 15_000,
    })

  const selectedJob = useMemo(
    () => jobs.find(j => j.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  )

  const { data: output, isLoading: outputLoading } = useHermesJobOutput(
    selectedJobId,
    { enabled: !!selectedJobId }
  )

  const projectName = (id?: string | null) =>
    projects.find(p => p.id === id)?.name ?? id ?? '—'

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col gap-4',
        embedded ? 'p-0' : 'h-full p-1'
      )}
    >
      {!embedded && (
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <CalendarClock className="size-5" />
            Hermes Jobs
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Scheduled work owned by the Hermes gateway — not by Jean. Creating a
            job installs the gateway as a user service so Hermes stays up for
            cron (and messaging) even when Jean is closed.
          </p>
        </div>
      )}

      {embedded && (
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2">
            <CalendarClock className="size-4" />
            Scheduled jobs
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Owned by the Hermes gateway. Creating a job keeps the gateway as a
            user service so cron runs even when Jean is closed.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {!embedded && (
          <div className="flex items-center gap-2">
            <Badge
              variant={status.data?.apiReachable ? 'default' : 'destructive'}
            >
              {status.data?.apiReachable ? 'Gateway up' : 'Gateway down'}
            </Badge>
            {!status.data?.apiReachable && (
              <Button
                size="sm"
                variant="outline"
                disabled={startGateway.isPending}
                onClick={() => startGateway.mutate()}
              >
                {startGateway.isPending ? 'Starting…' : 'Start gateway'}
              </Button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Switch
            id="include-disabled"
            checked={includeDisabled}
            onCheckedChange={setIncludeDisabled}
          />
          <Label htmlFor="include-disabled" className="text-sm">
            Show paused
          </Label>
        </div>

        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects
              .filter(p => !p.is_folder)
              .map(p => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={cn('size-4', isFetching && 'animate-spin')}
          />
        </Button>
      </div>

      {isError && (
        <div className="text-destructive flex items-start gap-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{String(error)}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-2">
        <ScrollArea className="border rounded-md min-h-[240px]">
          {isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading jobs…
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-muted-foreground p-4 text-sm">
              No Hermes jobs yet. Right-click a worktree →{' '}
              <strong>Schedule Hermes job</strong>, or create one with{' '}
              <code className="text-xs">hermes cron create</code>.
            </div>
          ) : (
            <ul className="divide-y">
              {jobs.map(job => (
                <JobRow
                  key={job.id}
                  job={job}
                  projectLabel={projectName(job.projectId)}
                  selected={job.id === selectedJobId}
                  busy={jobAction.isPending}
                  onSelect={() => setSelectedJobId(job.id)}
                  onPause={() =>
                    jobAction.mutate({ jobId: job.id, action: 'pause' })
                  }
                  onResume={() =>
                    jobAction.mutate({ jobId: job.id, action: 'resume' })
                  }
                  onRun={() =>
                    jobAction.mutate({ jobId: job.id, action: 'run' })
                  }
                  onDelete={() => {
                    if (
                      window.confirm(
                        `Delete Hermes job “${job.name}”? This cannot be undone.`
                      )
                    ) {
                      jobAction.mutate({ jobId: job.id, action: 'delete' })
                      if (selectedJobId === job.id) setSelectedJobId(null)
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </ScrollArea>

        <div className="border rounded-md flex min-h-[240px] flex-col">
          <div className="border-b flex items-center gap-2 px-3 py-2 text-sm font-medium">
            <FileText className="size-4" />
            Last local output
            {selectedJob && (
              <span className="text-muted-foreground font-normal truncate">
                — {selectedJob.name}
              </span>
            )}
          </div>
          <ScrollArea className="flex-1 p-3">
            {!selectedJob ? (
              <p className="text-muted-foreground text-sm">
                Select a job to view the latest{' '}
                <code className="text-xs">deliver: local</code> output from{' '}
                <code className="text-xs">~/.hermes/cron/output/</code>.
              </p>
            ) : outputLoading ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : output?.content ? (
              <pre className="whitespace-pre-wrap break-words text-xs font-mono">
                {output.content}
              </pre>
            ) : (
              <p className="text-muted-foreground text-sm">
                No output file yet
                {selectedJob.lastStatus
                  ? ` (last status: ${selectedJob.lastStatus})`
                  : ''}
                .
              </p>
            )}
            {output?.path && (
              <p className="text-muted-foreground mt-3 break-all text-[10px]">
                {output.path}
              </p>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}

function JobRow({
  job,
  projectLabel,
  selected,
  busy,
  onSelect,
  onPause,
  onResume,
  onRun,
  onDelete,
}: {
  job: HermesJob
  projectLabel: string
  selected: boolean
  busy: boolean
  onSelect: () => void
  onPause: () => void
  onResume: () => void
  onRun: () => void
  onDelete: () => void
}) {
  return (
    <li
      className={cn(
        'hover:bg-muted/50 cursor-pointer px-3 py-2.5 transition-colors',
        selected && 'bg-muted'
      )}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-sm">{job.name}</span>
            {!job.enabled && (
              <Badge variant="secondary" className="text-[10px]">
                paused
              </Badge>
            )}
            {job.lastStatus && (
              <Badge variant="outline" className="text-[10px]">
                {job.lastStatus}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {job.scheduleDisplay ?? '—'}
            {job.nextRunAt ? ` · next ${job.nextRunAt}` : ''}
          </p>
          <p className="text-muted-foreground truncate text-[11px]">
            {projectLabel}
            {job.workdir ? ` · ${job.workdir}` : ''}
          </p>
          {job.lastError && (
            <p className="text-destructive mt-0.5 line-clamp-1 text-[11px]">
              {job.lastError}
            </p>
          )}
        </div>
        <div
          className="flex shrink-0 gap-0.5"
          onClick={e => e.stopPropagation()}
        >
          {job.enabled ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={busy}
              title="Pause"
              onClick={onPause}
            >
              <Pause className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={busy}
              title="Resume"
              onClick={onResume}
            >
              <Play className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={busy}
            title="Run now"
            onClick={onRun}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-destructive"
            disabled={busy}
            title="Delete"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </li>
  )
}
