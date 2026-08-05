import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  Clock,
  ExternalLink,
  Flame,
  GitPullRequest,
  Loader2,
  PenLine,
  Search,
  Tag,
  UserCheck,
  UserPlus,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { openExternal } from '@/lib/platform'
import { clickupTaskUrl } from '@/lib/clickup'
import { reportSteps } from '@/lib/ai-pipeline-steps'
import { formatAge, taskMatchesQuery } from '@/lib/ai-pipeline-format'
import {
  useAiPipelineTasks,
  useResumeAiPipelineTask,
} from '@/services/ai-pipeline'
import type { AiPipelineTask, ResumeResult } from '@/types/ai-pipeline'

/**
 * One glanceable state per row: an icon *shape* plus a word, never color alone
 * (the whole point is scanning 20 tickets in one pass, colorblind included).
 */
interface RowState {
  icon: typeof CheckCircle2
  label: string
  hint: string
  className: string
}

function rowState(task: AiPipelineTask): RowState {
  if (!task.pr) {
    return {
      icon: CircleDashed,
      label: 'sans PR',
      hint: "La pipeline n'a poussé aucune PR — reprendre crée une branche neuve",
      className: 'text-muted-foreground',
    }
  }
  if (task.pr.mergeable === 'CONFLICTING') {
    return {
      icon: AlertTriangle,
      label: 'conflits',
      hint: 'La PR est en conflit avec la branche de base',
      className: 'text-orange-600 dark:text-orange-400',
    }
  }
  if (task.pr.ci === 'FAILURE') {
    return {
      icon: XCircle,
      label: 'CI KO',
      hint: 'La CI de la PR est en échec',
      className: 'text-red-600 dark:text-red-400',
    }
  }
  if (task.pr.ci === 'PENDING') {
    return {
      icon: Clock,
      label: 'CI…',
      hint: 'La CI de la PR est en cours',
      className: 'text-yellow-600 dark:text-yellow-500',
    }
  }
  if (task.pr.isDraft) {
    return {
      icon: PenLine,
      label: 'draft',
      hint: "PR en brouillon — la pipeline n'a pas terminé",
      className: 'text-muted-foreground',
    }
  }
  return {
    icon: CheckCircle2,
    label: 'CI OK',
    hint: 'PR prête : CI verte, pas de conflit',
    className: 'text-green-600 dark:text-green-400',
  }
}

/** Small metadata chip: always icon + text, never a bare color. */
function Chip({
  icon: Icon,
  children,
  tone = 'muted',
  title,
}: {
  icon?: typeof Tag
  children: React.ReactNode
  tone?: 'muted' | 'accent' | 'warn'
  title?: string
}) {
  const tones = {
    muted: 'bg-muted text-muted-foreground',
    accent: 'bg-primary/10 text-foreground',
    warn: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
  }
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${tones[tone]}`}
    >
      {Icon && <Icon className="size-2.5 shrink-0" />}
      {children}
    </span>
  )
}

function LinkChip({
  icon: Icon,
  label,
  url,
}: {
  icon: typeof ExternalLink
  label: string
  url: string
}) {
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        openExternal(url)
      }}
      className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:underline"
    >
      <Icon className="size-2.5" />
      {label}
    </button>
  )
}

function TaskRow({
  task,
  isResuming,
  isResumed,
  onResume,
}: {
  task: AiPipelineTask
  isResuming: boolean
  isResumed: boolean
  onResume: (task: AiPipelineTask) => void
}) {
  const state = rowState(task)
  const StateIcon = state.icon
  const age = formatAge(task.pr?.createdAt ?? task.updatedAt)
  const aiTags = task.tags.filter(t => t.startsWith('ai-')).slice(0, 2)
  const isHot = task.priority === 'high' || task.priority === 'urgent'

  return (
    <div
      className={`grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-md border px-3 py-2 transition-colors ${
        isResumed
          ? 'border-dashed border-border bg-muted/40 opacity-70'
          : 'border-border hover:bg-muted/40'
      }`}
    >
      {/* State gutter — shape + word, readable without color */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`flex w-12 flex-col items-center gap-0.5 pt-0.5 ${state.className}`}
          >
            <StateIcon className="size-4" />
            <span className="text-[9px] font-medium uppercase leading-none">
              {state.label}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">{state.hint}</TooltipContent>
      </Tooltip>

      <div className="min-w-0 space-y-1.5">
        <div className="truncate text-sm font-medium" title={task.name}>
          {task.name}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {task.assignedToMe ? (
            <Chip icon={UserCheck} tone="accent" title="Déjà assigné à toi">
              à moi
            </Chip>
          ) : (
            <Chip icon={UserPlus} title="Personne dessus — libre à prendre">
              libre
            </Chip>
          )}
          {task.status && <Chip>{task.status.toUpperCase()}</Chip>}
          {isHot && (
            <Chip icon={Flame} tone="warn" title="Priorité ClickUp">
              {task.priority}
            </Chip>
          )}
          {task.pr ? (
            <Chip icon={GitPullRequest} title={task.pr.branch}>
              #{task.pr.number}
            </Chip>
          ) : (
            <Chip icon={CircleDashed}>sans PR</Chip>
          )}
          {aiTags.map(tag => (
            <Chip key={tag} icon={Tag}>
              {tag}
            </Chip>
          ))}
          {age && (
            <Chip icon={Clock} title="Dernier mouvement">
              {age}
            </Chip>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {task.pr && (
            <LinkChip icon={ExternalLink} label="GitHub" url={task.pr.url} />
          )}
          <LinkChip
            icon={ClipboardList}
            label={`Ticket ${task.taskId}`}
            url={task.url ?? clickupTaskUrl(task.taskId)}
          />
        </div>
      </div>

      <Button
        size="sm"
        variant={isResumed ? 'ghost' : 'outline'}
        className="shrink-0"
        title={
          task.pr
            ? 'Crée un worktree depuis la PR et t’assigne sur la tâche ClickUp + la PR GitHub'
            : 'Crée un worktree sur une branche CU-… et t’assigne la tâche ClickUp'
        }
        onClick={() => onResume(task)}
        disabled={isResuming}
      >
        {isResuming && <Loader2 className="size-4 animate-spin" />}
        {isResumed ? 'Repris ✓' : 'Reprendre'}
      </Button>
    </div>
  )
}

function Section({
  title,
  description,
  tasks,
  resumingTaskId,
  resumedTaskIds,
  onResume,
  emptyLabel,
}: {
  title: string
  description: string
  tasks: AiPipelineTask[]
  resumingTaskId: string | null
  resumedTaskIds: Set<string>
  onResume: (task: AiPipelineTask) => void
  emptyLabel: string
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
          {title}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {description}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-1.5">
          {tasks.map(task => (
            <TaskRow
              key={task.taskId}
              task={task}
              isResuming={resumingTaskId === task.taskId}
              isResumed={resumedTaskIds.has(task.taskId)}
              onResume={onResume}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export interface AiPipelineTaskListProps {
  /** Project the lists are scoped to (already resolved by the caller). */
  projectId: string | null
  /** Only fetch when the host surface is visible. */
  enabled?: boolean
  /** Called after each successful resume — the list itself never navigates. */
  onResumed?: (result: ResumeResult) => void
  /** Rendered above the search field (e.g. the project picker). */
  header?: React.ReactNode
}

/**
 * The pickable pipeline tickets, in two buckets: review (PR found) and STUCK
 * (PR optional). Shared by the dedicated modal and the New Session tab so both
 * entry points behave identically.
 *
 * Resuming never closes anything: the row is marked as taken and the next
 * ticket is one click away.
 */
export function AiPipelineTaskList({
  projectId,
  enabled = true,
  onResumed,
  header,
}: AiPipelineTaskListProps) {
  const [query, setQuery] = useState('')
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null)
  const [resumedTaskIds, setResumedTaskIds] = useState<Set<string>>(new Set())

  const { data, isLoading, isError, error, isFetching, refetch } =
    useAiPipelineTasks(projectId, { enabled })
  const resume = useResumeAiPipelineTask(projectId)

  const review = useMemo(
    () => (data?.review ?? []).filter(t => taskMatchesQuery(t, query)),
    [data, query]
  )
  const stuck = useMemo(
    () => (data?.stuck ?? []).filter(t => taskMatchesQuery(t, query)),
    [data, query]
  )

  const handleResume = useCallback(
    (task: AiPipelineTask) => {
      const target = task.pr ? `PR #${task.pr.number}` : `ticket ${task.taskId}`
      const toastId = toast.loading(`Reprise de la ${target}…`)
      setResumingTaskId(task.taskId)
      resume.mutate(
        { taskId: task.taskId, prNumber: task.pr?.number },
        {
          onSuccess: res => {
            reportSteps(toastId, `${target} reprise`, [res.github, res.clickup])
            setResumedTaskIds(prev => new Set(prev).add(task.taskId))
            onResumed?.(res)
          },
          onError: e =>
            toast.error(`Échec de la reprise (${target}) : ${e}`, {
              id: toastId,
            }),
          onSettled: () => setResumingTaskId(null),
        }
      )
    },
    [resume, onResumed]
  )

  if (!projectId) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        Aucun projet sélectionné pour la pipeline IA.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {header}

      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filtrer : titre, tag, id ClickUp, n° de PR…"
          className="h-8 pl-8 text-base md:text-sm"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : isError ? (
        <div className="space-y-2 px-2 py-8 text-center">
          <p className="text-sm text-destructive">
            Erreur de chargement :{' '}
            {error instanceof Error ? error.message : String(error)}
          </p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Réessayer
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 pb-2 pr-2">
            <Section
              title="À reprendre"
              description="TO REVIEW / IN REVIEW · PR trouvée"
              tasks={review}
              resumingTaskId={resumingTaskId}
              resumedTaskIds={resumedTaskIds}
              onResume={handleResume}
              emptyLabel={
                query
                  ? 'Aucun ticket en review ne correspond au filtre.'
                  : 'Aucun ticket en review à reprendre (libre ou assigné à toi).'
              }
            />
            <Section
              title="Bloqués"
              description="STUCK · avec ou sans PR"
              tasks={stuck}
              resumingTaskId={resumingTaskId}
              resumedTaskIds={resumedTaskIds}
              onResume={handleResume}
              emptyLabel={
                query
                  ? 'Aucun ticket bloqué ne correspond au filtre.'
                  : 'Aucun ticket bloqué (libre ou assigné à toi).'
              }
            />
          </div>
        </ScrollArea>
      )}

      <div className="flex shrink-0 items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Reprendre garde la liste ouverte : enchaîne les tickets sans rouvrir.
        </span>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50"
        >
          {isFetching ? 'Actualisation…' : 'Actualiser'}
        </button>
      </div>
    </div>
  )
}

export default AiPipelineTaskList
