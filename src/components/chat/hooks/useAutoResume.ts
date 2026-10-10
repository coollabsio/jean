import { useEffect } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useSendMessage } from '@/services/chat'
import { logger } from '@/lib/logger'

const TICK_MS = 30_000

/**
 * Watches sessions armed for "auto-continue when limit resets" and re-sends the
 * failed prompt once the reset time passes. Single-shot per arming: if the
 * resend hits the limit again, `chat:error` fires and the banner reappears for
 * the user to re-arm (no silent retry loop).
 *
 * ponytail: frontend timer — only runs while the app is open. Upgrade path is a
 * backend survivable job if resume-while-fully-closed is ever needed.
 *
 * Mount once at app level (App.tsx) so it survives ChatWindow unmounts.
 */
export function useAutoResume() {
  const sendMessage = useSendMessage()

  useEffect(() => {
    const fireDue = () => {
      const { autoResume, lastSentArgs, disarmAutoResume, setError, setInputDraft, isSending } =
        useChatStore.getState()

      const now = Date.now()
      for (const [sessionId, resumeAtMs] of Object.entries(autoResume)) {
        if (resumeAtMs != null && now < resumeAtMs) continue
        if (isSending(sessionId)) continue

        const args = lastSentArgs[sessionId]
        // Single-shot: disarm before sending so a repeat limit error does not
        // immediately re-fire. Missing args (e.g. cleared) → just disarm.
        disarmAutoResume(sessionId)
        if (!args) {
          logger.warn('Auto-continue skipped: no saved send args', { sessionId })
          continue
        }

        // Clear the restored error + input draft so the resend replaces them.
        setError(sessionId, null)
        setInputDraft(sessionId, '')

        logger.info('Auto-continuing session after limit reset', { sessionId })
        sendMessage.mutate(args, {
          onError: err => {
            logger.warn('Auto-continue resend failed', {
              sessionId,
              error: String(err),
            })
          },
        })
      }
    }

    // Fire once on mount (covers a restart where the reset time already passed),
    // then poll.
    fireDue()
    const id = setInterval(fireDue, TICK_MS)
    return () => clearInterval(id)
  }, [sendMessage])
}
