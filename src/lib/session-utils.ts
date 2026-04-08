import {
  CheckCircle2,
  AlertTriangle,
  CirclePause,
  HelpCircle,
  FileText,
} from 'lucide-react'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { Session } from '@/types/chat'

/** A session with its parent project/worktree context */
export interface SessionListItem {
  session: Session
  projectId: string
  projectName: string
  worktreeId: string
  worktreeName: string
  worktreePath: string
}

/**
 * Whether a session has a notification-worthy status (completed/cancelled/crashed/
 * waiting/reviewing), regardless of whether the user has already seen it.
 */
export function isActionable(session: Session): boolean {
  if (session.archived_at) return false
  const actionableStatuses = ['completed', 'cancelled', 'crashed']
  const hasFinishedRun =
    session.last_run_status &&
    actionableStatuses.includes(session.last_run_status)
  const isWaiting = session.waiting_for_input
  const isReviewing = session.is_reviewing
  return !!(hasFinishedRun || isWaiting || isReviewing)
}

/** Whether a session is actionable AND the user hasn't opened it since its last update */
export function isUnread(session: Session): boolean {
  if (!isActionable(session)) return false
  if (!session.last_opened_at) return true
  return session.last_opened_at < session.updated_at
}

/** Format a unix timestamp (seconds or ms) to relative time like "2m ago", "3h ago" */
export function formatRelativeTime(timestamp: number): string {
  const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
  const diffMs = Date.now() - ms
  if (diffMs < 0) return 'just now'
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (diffMs < hourMs)
    return `${Math.max(1, Math.floor(diffMs / minuteMs))}m ago`
  if (diffMs < dayMs) return `${Math.floor(diffMs / hourMs)}h ago`
  return `${Math.floor(diffMs / dayMs)}d ago`
}

/** Get display info (icon, label, color) for a session's current state */
export function getSessionStatus(session: Session) {
  if (session.waiting_for_input) {
    const isplan = session.waiting_for_input_type === 'plan'
    return {
      icon: isplan ? FileText : HelpCircle,
      label: isplan ? 'Needs approval' : 'Needs input',
      className: 'text-yellow-500',
    }
  }
  const config: Record<
    string,
    { icon: typeof CheckCircle2; label: string; className: string }
  > = {
    completed: {
      icon: CheckCircle2,
      label: 'Completed',
      className: 'text-green-500',
    },
    cancelled: {
      icon: CirclePause,
      label: 'Cancelled',
      className: 'text-muted-foreground',
    },
    crashed: {
      icon: AlertTriangle,
      label: 'Crashed',
      className: 'text-destructive',
    },
  }
  if (session.last_run_status && config[session.last_run_status]) {
    return config[session.last_run_status]
  }
  return null
}

/**
 * Cross-project-aware navigation to a session.
 * Handles project switching, clearActiveWorktree, setActiveSession,
 * setLastOpenedForProject, and the cross-project auto-open vs same-project
 * event dispatch pattern.
 */
export function navigateToSession(item: SessionListItem): void {
  const { selectedProjectId, selectProject } = useProjectsStore.getState()
  const { setActiveSession, clearActiveWorktree, setLastOpenedForProject } =
    useChatStore.getState()

  const crossProject = selectedProjectId !== item.projectId
  if (crossProject) {
    selectProject(item.projectId)
  }

  clearActiveWorktree()
  setActiveSession(item.worktreeId, item.session.id)
  setLastOpenedForProject(item.projectId, item.worktreeId, item.session.id)

  if (crossProject) {
    // Component remounts with new projectId key — use store-based auto-open
    useUIStore
      .getState()
      .markWorktreeForAutoOpenSession(item.worktreeId, item.session.id)
  } else {
    // Same project, component stays mounted — use event
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('open-session-modal', {
          detail: {
            sessionId: item.session.id,
            worktreeId: item.worktreeId,
            worktreePath: item.worktreePath,
          },
        })
      )
    }, 50)
  }
}
