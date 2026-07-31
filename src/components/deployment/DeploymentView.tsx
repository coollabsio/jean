import { useCallback, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  Rocket,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useUIStore } from '@/store/ui-store'
import { useAiPipelineProjectId } from '@/services/ai-pipeline'
import {
  useCloseAllDeployedTasks,
  useCloseDeployedTask,
  useDeploymentOverview,
} from '@/services/deployment'
import type { DeploymentTask } from '@/types/deployment'
import { openExternal } from '@/lib/platform'
import { cn } from '@/lib/utils'

function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

function taskState(task: DeploymentTask) {
  if (task.state === 'deployed') {
    return {
      label: 'Déployé',
      icon: CheckCircle2,
      className: 'text-green-600 dark:text-green-400',
    }
  }
  if (task.state === 'pending') {
    return {
      label: 'Pas encore en prod',
      icon: Clock3,
      className: 'text-yellow-600 dark:text-yellow-500',
    }
  }
  return {
    label: 'Correspondance incertaine',
    icon: AlertTriangle,
    className: 'text-muted-foreground',
  }
}

export function DeploymentView() {
  const { projectId, project } = useAiPipelineProjectId()
  const overview = useDeploymentOverview(projectId)
  const closeOne = useCloseDeployedTask(projectId)
  const closeAll = useCloseAllDeployedTasks(projectId)
  const [confirmTask, setConfirmTask] = useState<DeploymentTask | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const deployedTasks = useMemo(
    () => overview.data?.tasks.filter(task => task.state === 'deployed') ?? [],
    [overview.data]
  )
  const timelineTasks = useMemo(
    () => overview.data?.tasks.filter(task => task.pullRequest) ?? [],
    [overview.data]
  )
  const uncertainTasks = useMemo(
    () => overview.data?.tasks.filter(task => !task.pullRequest) ?? [],
    [overview.data]
  )

  const close = useCallback(() => {
    useUIStore.getState().setDeploymentOpen(false)
  }, [])

  const handleCloseOne = useCallback(() => {
    if (!confirmTask) return
    const task = confirmTask
    setConfirmTask(null)
    const toastId = toast.loading(`Clôture de CU-${task.taskId}…`)
    closeOne.mutate(task.taskId, {
      onSuccess: result => {
        const archived = result.archivedWorktreeIds.length
        toast.success(
          archived
            ? `Ticket clôturé · ${archived} worktree archivé`
            : 'Ticket clôturé',
          { id: toastId }
        )
        result.archiveErrors.forEach(error => toast.error(error))
      },
      onError: error => toast.error(`Échec : ${error}`, { id: toastId }),
    })
  }, [closeOne, confirmTask])

  const handleCloseAll = useCallback(() => {
    setConfirmAll(false)
    const toastId = toast.loading(
      `Clôture de ${deployedTasks.length} tickets déployés…`
    )
    closeAll.mutate(undefined, {
      onSuccess: results => {
        const closed = results.filter(result => result.closed).length
        const failed = results.length - closed
        const archived = results.reduce(
          (total, result) => total + result.archivedWorktreeIds.length,
          0
        )
        toast.success(
          `${closed} tickets clôturés${archived ? ` · ${archived} worktree(s) archivé(s)` : ''}${failed ? ` · ${failed} échec(s)` : ''}`,
          { id: toastId }
        )
        results
          .flatMap(result => (result.error ? [result.error] : []))
          .forEach(error => {
            toast.error(error)
          })
        results
          .flatMap(result => result.archiveErrors)
          .forEach(error => {
            toast.error(error)
          })
      },
      onError: error => toast.error(`Échec : ${error}`, { id: toastId }),
    })
  }, [closeAll, deployedTasks.length])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" onClick={close} aria-label="Retour">
          <ArrowLeft className="size-4" />
        </Button>
        <Rocket className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">Déploiement production</h1>
          <p className="text-xs text-muted-foreground">
            {deployedTasks.length} ticket
            {deployedTasks.length === 1 ? '' : 's'} déployé
            {deployedTasks.length === 1 ? '' : 's'} clôturable
            {deployedTasks.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => overview.refetch()}
          disabled={overview.isFetching}
        >
          <RefreshCw
            className={cn('size-3.5', overview.isFetching && 'animate-spin')}
          />
          Rafraîchir
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
          {overview.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Vérification de ClickUp, GitHub et de la production…
            </div>
          ) : overview.error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">
                Impossible de vérifier le déploiement
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {String(overview.error)}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => overview.refetch()}
              >
                Réessayer
              </Button>
            </div>
          ) : overview.data ? (
            <>
              <section className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center">
                <div className="flex items-center gap-3">
                  <span className="grid size-8 place-items-center rounded-full border border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400">
                    <CheckCircle2 className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">Production identifiée</p>
                    <button
                      type="button"
                      className="text-left text-xs text-muted-foreground hover:underline"
                      onClick={() => openExternal(overview.data.versionUrl)}
                    >
                      {overview.data.versionUrl}
                    </button>
                  </div>
                </div>
                <div className="sm:border-l sm:pl-4">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Commit en production
                  </p>
                  <code className="text-xs">{overview.data.productionSha}</code>
                </div>
                <div className="sm:border-l sm:pl-4">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Branche comparée
                  </p>
                  <code className="text-xs">{overview.data.remoteBranch}</code>
                </div>
              </section>

              <div className="flex items-end gap-3">
                <div>
                  <h2 className="text-sm font-semibold">
                    {overview.data.remoteBranch} → production
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Du commit le plus récent au plus ancien.
                  </p>
                </div>
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={deployedTasks.length === 0 || closeAll.isPending}
                  onClick={() => setConfirmAll(true)}
                >
                  Clôturer les {deployedTasks.length} déployés
                </Button>
              </div>

              <section className="rounded-lg border bg-card px-4 pb-4">
                <div className="relative ml-3 border-l border-border pt-4">
                  {timelineTasks.map((task, index) => (
                    <TimelineTask
                      key={task.taskId}
                      task={task}
                      isBoundary={
                        task.state === 'deployed' &&
                        timelineTasks[index - 1]?.state !== 'deployed'
                      }
                      onClose={() => setConfirmTask(task)}
                    />
                  ))}
                  {timelineTasks.length === 0 && (
                    <p className="py-8 pl-6 text-sm text-muted-foreground">
                      Aucun ticket TO DEPLOY lié à une PR mergée.
                    </p>
                  )}
                </div>
              </section>

              {uncertainTasks.length > 0 && (
                <section className="overflow-hidden rounded-lg border bg-card">
                  <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium">
                    <AlertTriangle className="size-3.5 text-muted-foreground" />
                    Correspondance incertaine ({uncertainTasks.length})
                  </div>
                  {uncertainTasks.map(task => (
                    <div
                      key={task.taskId}
                      className="flex items-center gap-3 border-b px-3 py-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {task.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          CU-{task.taskId} · {task.reason}
                        </p>
                      </div>
                      {task.url && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          onClick={() => {
                            if (task.url) openExternal(task.url)
                          }}
                        >
                          Ouvrir ClickUp
                        </Button>
                      )}
                    </div>
                  ))}
                </section>
              )}
            </>
          ) : (
            <p className="py-20 text-center text-sm text-muted-foreground">
              Aucun projet configuré pour le déploiement ({project?.name ?? '—'}
              ).
            </p>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!confirmTask}
        onOpenChange={open => !open && setConfirmTask(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clôturer ce ticket déployé ?</AlertDialogTitle>
            <AlertDialogDescription>
              CU-{confirmTask?.taskId} passera en CLOSED.
              {!!confirmTask?.worktrees.length &&
                ` ${confirmTask.worktrees.length} worktree(s) actif(s) seront archivés.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleCloseOne}>
              Clôturer et archiver
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clôturer {deployedTasks.length} tickets déployés ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Jean revérifiera la production, passera les tickets en CLOSED puis
              archivera leurs worktrees actifs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3 text-xs">
            {deployedTasks.map(task => (
              <div key={task.taskId} className="flex justify-between gap-3">
                <span className="truncate">
                  CU-{task.taskId} · {task.name}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {task.worktrees.length
                    ? `${task.worktrees.length} worktree(s)`
                    : 'ticket uniquement'}
                </span>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleCloseAll}>
              Tout clôturer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TimelineTask({
  task,
  isBoundary,
  onClose,
}: {
  task: DeploymentTask
  isBoundary: boolean
  onClose: () => void
}) {
  const view = taskState(task)
  const StateIcon = view.icon
  const pr = task.pullRequest
  if (!pr) return null
  return (
    <article
      className={cn(
        'relative mb-3 ml-6 grid gap-3 rounded-md border p-3 sm:grid-cols-[100px_1fr_170px_auto] sm:items-center',
        isBoundary && 'border-green-500/40 bg-green-500/5'
      )}
    >
      <span
        className={cn(
          'absolute -left-[31px] top-5 size-3 rounded-full border-[3px] border-card bg-muted-foreground',
          task.state === 'deployed' && 'bg-green-500',
          task.state === 'pending' && 'bg-yellow-500'
        )}
      />
      {isBoundary && (
        <span className="absolute -top-2 right-3 rounded bg-green-900 px-1.5 py-0.5 text-[9px] font-medium text-green-100">
          FRONTIÈRE PRODUCTION
        </span>
      )}
      <code className="text-xs text-muted-foreground">
        {shortSha(pr.mergeCommit)}
      </code>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{task.name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            className="hover:text-foreground hover:underline"
            onClick={() => task.url && openExternal(task.url)}
          >
            CU-{task.taskId}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            onClick={() => openExternal(pr.url)}
          >
            PR #{pr.number} <ExternalLink className="size-3" />
          </button>
          <span className="inline-flex items-center gap-1" title={pr.branch}>
            <GitBranch className="size-3" />
            {pr.branch}
          </span>
        </div>
      </div>
      <div className={cn('text-xs', view.className)}>
        <span className="inline-flex items-center gap-1 font-medium">
          <StateIcon className="size-3.5" /> {view.label}
        </span>
        {task.worktrees.length > 0 && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {task.worktrees.length} worktree(s) actif(s)
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={task.state !== 'deployed'}
        onClick={onClose}
      >
        {task.state === 'deployed' ? 'Clôturer' : 'En attente'}
      </Button>
    </article>
  )
}

export default DeploymentView
