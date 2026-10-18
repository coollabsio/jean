import { useEffect } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useSendMessage } from '@/services/chat'
import { logger } from '@/lib/logger'

const TICK_MS = 5_000

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
  const { mutate: sendMessage } = useSendMessage()

  useEffect(() => {
    const fireDue = () => {
      const store = useChatStore.getState()
      const now = Date.now()
      for (const [sessionId, resumeAtMs] of Object.entries(store.autoResume)) {
        if (now < resumeAtMs) continue
        if (store.isSending(sessionId)) continue

        const args = store.lastSentArgs[sessionId]
        // Single-shot: disarm before sending so a repeat limit error does not
        // immediately re-fire. Missing args (e.g. cleared) → just disarm.
        store.disarmAutoResume(sessionId)
        if (!args) {
          logger.warn('Auto-continue skipped: no saved send args', {
            sessionId,
          })
          continue
        }

        // The failed send restored its prompt and attachments into the input.
        // The replayed message already carries them, so clear the input like a
        // manual send, and track them so a repeat failure restores them again.
        const images = store.pendingImages[sessionId] ?? []
        const files = store.pendingFiles[sessionId] ?? []
        const textFiles = store.pendingTextFiles[sessionId] ?? []
        const skills = store.pendingSkills[sessionId] ?? []
        if (
          images.length ||
          files.length ||
          textFiles.length ||
          skills.length
        ) {
          store.setLastSentAttachments(sessionId, {
            images,
            files,
            textFiles,
            skills,
          })
        }
        store.clearPendingImages(sessionId)
        store.clearPendingFiles(sessionId)
        store.clearPendingTextFiles(sessionId)
        store.clearPendingSkills(sessionId)
        store.setInputDraft(sessionId, '')
        store.setLastSentMessage(sessionId, args.message)
        store.setError(sessionId, null)

        logger.info('Auto-continuing session after limit reset', { sessionId })
        sendMessage(args, {
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
