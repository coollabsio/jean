import { useState } from 'react'
import { Archive } from '@/components/icons/reicon'
import { useSelectedAgent } from '@/components/agents/agents'
import { formatLocalTime } from '@/components/chat/time-utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Markdown } from '@/components/ui/markdown'
import { useAgentDetails } from '@/services/agents'
import { chatContinuedJournalId } from './message-content-utils'

/** Shown in place of Jean's message that starts a continued agent chat. */
export function ChatContinuedNotice({ content }: { content: string }) {
  const journalId = chatContinuedJournalId(content)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground">
      <Archive className="size-3.5" aria-hidden />
      <span>
        {journalId
          ? 'Previous chat saved to the journal.'
          : 'Previous chat archived.'}
      </span>
      {journalId && (
        <button
          type="button"
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen(true)}
        >
          Show
        </button>
      )}
      {journalId && open && (
        <JournalEntryDialog
          journalId={journalId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function JournalEntryDialog({
  journalId,
  onClose,
}: {
  journalId: number
  onClose: () => void
}) {
  const { agent } = useSelectedAgent()
  const { data, isLoading } = useAgentDetails(agent?.id ?? null)
  const entry = data?.journal.find(item => item.id === journalId)
  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Journal entry #{journalId}</DialogTitle>
          <DialogDescription>
            {entry
              ? `End of the archived chat, saved ${formatLocalTime(entry.createdAt)}.`
              : 'End of the archived chat.'}
          </DialogDescription>
        </DialogHeader>
        {entry ? (
          <Markdown className="text-sm">{entry.content}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? 'Loading…'
              : 'This entry is not in the recent journal. Open Memory to search it.'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
