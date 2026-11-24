import { useEffect } from 'react'
import { toast } from 'sonner'
import { listen } from '@/lib/transport'
import { useProjectsStore } from '@/store/projects-store'
import { isCoordinatorViewActive } from '@/hooks/useMainWindowEventListeners'
import { coordinatorProjectId } from './agents'
import { useAgentsEnabled } from './agents-feature'
import { openProjectCoordinator } from './open-coordinator'

interface AgentNotificationEvent {
  agentId: string
  agentName: string
  level: string
  message: string
  /** A delegated session's update (not `notify_user`) */
  sessionUpdate?: boolean
}

function openAgent(agentId: string) {
  const projectId = coordinatorProjectId(agentId)
  if (projectId) openProjectCoordinator(projectId)
}

/** True when the user looks at this coordinator's chat now. */
export function isCoordinatorChatInView(agentId: string): boolean {
  const projectId = coordinatorProjectId(agentId)
  return (
    projectId !== null &&
    isCoordinatorViewActive() &&
    useProjectsStore.getState().selectedProjectId === projectId &&
    document.hasFocus()
  )
}

/**
 * Shows a toast when a coordinator calls `notify_user`, or when one of its
 * sessions finishes, fails, or waits for input. A session update is skipped
 * while that coordinator's chat is in view: its reply shows there. Renders
 * nothing.
 */
export function AgentNotificationsListener() {
  const enabled = useAgentsEnabled()

  useEffect(() => {
    if (!enabled) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void listen<AgentNotificationEvent>('agents:notification', event => {
      const { agentId, agentName, level, message, sessionUpdate } =
        event.payload
      if (sessionUpdate && isCoordinatorChatInView(agentId)) return
      const show =
        level === 'error'
          ? toast.error
          : level === 'action'
            ? toast.warning
            : toast.info
      show(agentName, {
        description:
          message.length > 240 ? `${message.slice(0, 240)}…` : message,
        action: { label: 'Open', onClick: () => openAgent(agentId) },
      })
    }).then(fn => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled])

  return null
}
