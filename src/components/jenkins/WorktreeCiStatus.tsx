import type { ReactNode } from 'react'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Hourglass,
  Globe,
  Settings2,
  HelpCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { useJenkinsStatusCached } from '@/services/jenkins'
import { useProjects } from '@/services/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'
import { PIPELINE_JOB } from '@/components/jenkins/jenkins-jobs'

interface WorktreeCiStatusProps {
  projectId: string
  worktreeId: string
  /** GitHub PR number as a string (or null). The badge lives at the PR level. */
  prId?: string | null
}

interface PillSpec {
  key: string
  icon: ReactNode
  label: string
  tone: string
  tooltip: string
}

/**
 * Meaning is carried by the ICON SHAPE + TEXT label so the status is readable
 * without relying on color (accessible to colorblind users). Color is only a
 * redundant secondary cue.
 */
const TONE = {
  green:
    'text-green-700 dark:text-green-400 border-green-600/30 bg-green-500/10',
  red: 'text-red-700 dark:text-red-400 border-red-600/30 bg-red-500/10',
  amber:
    'text-amber-700 dark:text-amber-400 border-amber-600/30 bg-amber-500/10',
  blue: 'text-blue-700 dark:text-blue-400 border-blue-600/30 bg-blue-500/10',
  muted: 'text-muted-foreground border-border bg-muted/40',
} as const

const ICON = 'size-3 shrink-0'

/**
 * Suffix appended to the verdict tooltip when the verdict was recovered from
 * the PR's GitHub commit status — Jenkins keeps a very short build history, so
 * an hours-old build is simply gone and there is no Jenkins run to link to.
 */
const GITHUB_SOURCE_NOTE =
  ' — verdict GitHub (build purgé de l’historique Jenkins)'

/** Pipeline verdict → a shaped, labelled pill (or null for UNKNOWN). */
function verdictPill(status: string): PillSpec | null {
  switch (status) {
    case 'SUCCESS':
      return {
        key: 'ci',
        icon: <CheckCircle2 className={ICON} />,
        label: 'CI OK',
        tone: TONE.green,
        tooltip: `${PIPELINE_JOB} : réussi`,
      }
    case 'FAILURE':
      return {
        key: 'ci',
        icon: <XCircle className={ICON} />,
        label: 'CI échec',
        tone: TONE.red,
        tooltip: `${PIPELINE_JOB} : en échec`,
      }
    case 'BUILDING':
      return {
        key: 'ci',
        icon: <Loader2 className={cn(ICON, 'animate-spin')} />,
        label: 'CI en cours',
        tone: TONE.blue,
        tooltip: `${PIPELINE_JOB} : en cours`,
      }
    case 'QUEUED':
      return {
        key: 'ci',
        icon: <Hourglass className={ICON} />,
        label: 'CI en file',
        tone: TONE.amber,
        tooltip: `${PIPELINE_JOB} : en file d'attente`,
      }
    default:
      return null
  }
}

/** Preview freshness → a shaped, labelled pill (or null when nothing to show). */
function previewPill(status: JenkinsWorktreeStatus): PillSpec | null {
  if (!status.previewUrl) return null
  switch (status.previewFreshness?.status) {
    case 'UP_TO_DATE':
      return {
        key: 'preview',
        icon: <Globe className={ICON} />,
        label: 'Preview à jour',
        tone: TONE.green,
        tooltip: 'Preview à jour avec la PR',
      }
    case 'STALE':
      return {
        key: 'preview',
        icon: <Globe className={ICON} />,
        label: 'Preview périmée',
        tone: TONE.amber,
        tooltip: 'Preview périmée — en retard sur la PR',
      }
    case 'DOWN':
      return {
        key: 'preview',
        icon: <Globe className={ICON} />,
        label: 'Preview hors ligne',
        tone: TONE.red,
        tooltip: 'Preview hors ligne (injoignable)',
      }
    default:
      return null
  }
}

function testablePill(status: JenkinsWorktreeStatus): PillSpec | null {
  if (
    status.overallStatus !== 'SUCCESS' ||
    status.previewFreshness?.status !== 'UP_TO_DATE'
  ) {
    return null
  }
  return {
    key: 'testable',
    icon: <CheckCircle2 className={ICON} />,
    label: 'Testable',
    tone: TONE.green,
    tooltip: 'CI réussie et preview à jour avec le dernier commit de la PR',
  }
}

function Pill({ spec }: { spec: PillSpec }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-none',
            spec.tone
          )}
        >
          {spec.icon}
          {spec.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{spec.tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Jenkins status for a worktree LIST row (sidebar & canvas), shown as compact,
 * **shaped + labelled pills** on their own line — readable without color.
 *
 * Reads the poller-fed cache only (`useJenkinsStatusCached`); never fetches, so
 * it scales to N rows. The detailed popovers stay in the worktree
 * (`JenkinsStatusBadge` / `PreviewBadge`).
 *
 * Renders nothing when: no PR; project not loaded; configured but not polled
 * yet. Otherwise it always says *something* — "CI non configuré" when the
 * project has no Jenkins settings, "CI inconnu" when neither Jenkins nor GitHub
 * knows a verdict — so a silent row never gets mistaken for a broken badge.
 */
export function WorktreeCiStatus({
  projectId,
  worktreeId,
  prId,
}: WorktreeCiStatusProps) {
  const { data: status } = useJenkinsStatusCached(worktreeId)
  const { data: projects = [] } = useProjects()

  if (!prId) return null

  const ready = status ? testablePill(status) : null
  const pills = ready
    ? [ready]
    : status
      ? [verdictPill(status.overallStatus), previewPill(status)].filter(
          (p): p is PillSpec => p !== null
        )
      : []

  if (pills.length > 0) {
    const note = status?.verdictSource === 'github' ? GITHUB_SOURCE_NOTE : ''
    return (
      <div className="flex flex-wrap items-center gap-1">
        {pills.map(spec => (
          <Pill
            key={spec.key}
            spec={
              spec.key === 'ci' && note
                ? { ...spec, tooltip: `${spec.tooltip}${note}` }
                : spec
            }
          />
        ))}
      </div>
    )
  }

  const project = projects.find(p => p.id === projectId)
  // Projects not loaded yet — say nothing rather than guess "unconfigured".
  if (!project) return null

  const jenkinsConfigured =
    !!project.jenkins_url ||
    !!project.jenkins_user ||
    !!project.jenkins_token ||
    !!project.jenkins_preview_url_template

  if (!jenkinsConfigured) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Pill
          spec={{
            key: 'unconfigured',
            icon: <Settings2 className={ICON} />,
            label: 'CI non configuré',
            tone: TONE.muted,
            tooltip: 'Jenkins non configuré — Réglages du projet',
          }}
        />
      </div>
    )
  }

  // Configured but never polled for this row yet — avoid a spurious pill.
  if (!status) return null

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Pill
        spec={{
          key: 'unknown',
          icon: <HelpCircle className={ICON} />,
          label: 'CI inconnu',
          tone: TONE.muted,
          tooltip:
            'Aucun verdict : ni build Jenkins retrouvé pour cette PR, ni statut GitHub',
        }}
      />
    </div>
  )
}
