import { useEffect } from 'react'
import { toast } from 'sonner'
import { listen } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import { useAgentsEnabled } from './agents-feature'

interface AgentNotificationEvent {
  agentId: string
  agentName: string
  level: string
  message: string
}

function openAgent(agentId: string) {
  const ui = useUIStore.getState()
  ui.setRailSection('agents')
  ui.setSelectedAgentId(agentId)
}

/** Shows a toast when an agent calls `notify_user`. Renders nothing. */
export function AgentNotificationsListener() {
  const enabled = useAgentsEnabled()

  useEffect(() => {
    if (!enabled) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void listen<AgentNotificationEvent>('agents:notification', event => {
      const { agentId, agentName, level, message } = event.payload
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
