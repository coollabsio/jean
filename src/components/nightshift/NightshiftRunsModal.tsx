import { useCallback } from 'react'
import {
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  Moon,
  ExternalLink,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useNightshiftStore } from '@/store/nightshift-store'
import { useNightshiftRuns } from '@/services/nightshift'
import type {
  NightshiftRun,
  NightshiftRunStatus,
} from '@/types/nightshift'

function StatusBadge({ status }: { status: NightshiftRunStatus }) {
  switch (status) {
    case 'completed':
      return (
        <Badge variant="default" className="bg-green-600 text-white">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Completed
        </Badge>
      )
    case 'running':
      return (
        <Badge variant="default" className="bg-blue-600 text-white">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Running
        </Badge>
      )
    case 'failed':
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3 mr-1" />
          Failed
        </Badge>
      )
    case 'partially_completed':
      return (
        <Badge variant="default" className="bg-amber-600 text-white">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Partial
        </Badge>
      )
    case 'cancelled':
      return (
        <Badge variant="secondary">
          <XCircle className="h-3 w-3 mr-1" />
          Cancelled
        </Badge>
      )
    default:
      return (
        <Badge variant="secondary">
          <Clock className="h-3 w-3 mr-1" />
          Pending
        </Badge>
      )
  }
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`
}

function RunDetail({ run }: { run: NightshiftRun }) {
  const completedChecks = run.checkResults.filter(
    (cr) => cr.status === 'completed'
  ).length
  const startDate = new Date(run.startedAt * 1000)
  const duration = run.completedAt
    ? run.completedAt - run.startedAt
    : undefined

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-3 w-full p-3 rounded-lg border hover:bg-muted/50 transition-colors">
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform [[data-state=open]>&]:rotate-180" />
        <div className="flex-1 text-left">
          <div className="flex items-center gap-2">
            <Moon className="h-3.5 w-3.5 text-purple-500 dark:text-purple-400" />
            <span className="text-sm font-medium">
              {startDate.toLocaleDateString()}{' '}
              {startDate.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <StatusBadge status={run.status} />
            <span className="text-xs text-muted-foreground capitalize">
              {run.trigger}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {completedChecks}/{run.checkResults.length} checks completed
            {duration !== undefined ? ` · ${formatDuration(duration)}` : ''}
            {run.branchName && (
              <span className="ml-1">· {run.branchName}</span>
            )}
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-7 pr-3 pb-3 pt-2 space-y-2">
          {run.checkResults.map((cr) => (
            <div
              key={cr.checkId}
              className="flex items-center gap-2 p-2 rounded-md border border-border/50"
            >
              <StatusBadge status={cr.status} />
              <span className="text-xs font-medium text-foreground flex-1">
                {cr.checkId}
              </span>
              {cr.durationSecs > 0 && (
                <span className="text-xs text-muted-foreground">
                  {formatDuration(cr.durationSecs)}
                </span>
              )}
              {cr.sessionId && (
                <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                  <ExternalLink className="h-3 w-3" />
                  Session
                </span>
              )}
              {cr.error && (
                <span className="text-xs text-destructive truncate max-w-[200px]">
                  {cr.error}
                </span>
              )}
            </div>
          ))}
          {run.prUrl && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              <a
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-500 hover:underline"
              >
                PR #{run.prNumber}
              </a>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function NightshiftRunsModal() {
  const { runsModalOpen, runsModalProjectId, closeRunsModal } =
    useNightshiftStore()
  const { data: runs = [], isLoading } = useNightshiftRuns(runsModalProjectId)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeRunsModal()
    },
    [closeRunsModal]
  )

  if (!runsModalOpen) return null

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-2xl max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-1">
          <DialogTitle className="text-lg font-semibold">
            Nightshift Runs
          </DialogTitle>
          <ModalCloseButton onClick={() => handleOpenChange(false)} />
        </div>
        <DialogDescription className="sr-only">
          History of automated maintenance runs and their sessions.
        </DialogDescription>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!isLoading && runs.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No runs yet. Run Nightshift from project settings or the command
              palette.
            </div>
          )}
          {runs.map((run) => (
            <RunDetail key={run.id} run={run} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
