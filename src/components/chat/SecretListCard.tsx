import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Trash2 } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { SecretEntry } from './secret-request'

const DAY_SECONDS = 24 * 60 * 60

const TOGGLE_ITEM_CLASS =
  'flex-none rounded-sm px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm'

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ownerText(entry: SecretEntry): string {
  if (!entry.ownerName) return 'No project'
  return entry.ownerId.startsWith('agent:')
    ? `Agent ${entry.ownerName}`
    : entry.ownerName
}

function retentionText(entry: SecretEntry): string {
  return entry.retention === 'day'
    ? `deleted ${formatDate(entry.savedAt + DAY_SECONDS)}`
    : 'kept until deleted'
}

/**
 * Card for a Jean MCP `list_secrets` call: the saved secrets of this chat's
 * owner (its project, or its agent in agent sessions) or of all owners, with
 * a Delete button each. Shows live data, never values or file paths.
 * `sessionId` picks the owner and routes the commands to the server that owns
 * this chat.
 */
export function SecretListCard({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient()
  const [allOwners, setAllOwners] = useState(false)
  const { data: secrets, isLoading } = useQuery({
    queryKey: ['secret-request', 'list', sessionId, allOwners],
    queryFn: () =>
      invoke<SecretEntry[]>('list_secrets', { sessionId, allOwners }),
  })
  const [deleting, setDeleting] = useState<string | null>(null)

  const remove = async (entry: SecretEntry) => {
    setDeleting(entry.id)
    try {
      await invoke('delete_secret', { sessionId, id: entry.id })
      await queryClient.invalidateQueries({ queryKey: ['secret-request'] })
      toast.success(`Deleted "${entry.label}"`)
    } catch (error) {
      toast.error(`Could not delete the secret: ${String(error)}`)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <section
      aria-label="Saved secrets"
      className="my-2 flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          Saved secrets
          {secrets && secrets.length > 0 && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {secrets.length}
            </span>
          )}
        </h3>
        <ToggleGroup
          type="single"
          value={allOwners ? 'all' : 'here'}
          onValueChange={value => {
            if (value) setAllOwners(value === 'all')
          }}
          aria-label="Secrets to show"
          size="sm"
          className="gap-0.5 rounded-md bg-muted p-0.5"
        >
          <ToggleGroupItem value="here" className={TOGGLE_ITEM_CLASS}>
            This chat
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className={TOGGLE_ITEM_CLASS}>
            All
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !secrets || secrets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {allOwners
            ? 'No saved secrets.'
            : 'No saved secrets for this project or agent.'}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-border/60">
          {secrets.map(entry => (
            <li
              key={entry.id}
              className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0"
            >
              <KeyRound
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{entry.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {allOwners && `${ownerText(entry)} · `}
                  Saved {formatDate(entry.savedAt)} · {retentionText(entry)}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                disabled={deleting === entry.id}
                aria-label={`Delete ${entry.label}`}
                onClick={() => void remove(entry)}
              >
                <Trash2 className="size-3.5" aria-hidden />
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Values are never shown. Secrets are reused only within their project or
        agent. A deleted secret is gone for every agent.
      </p>
    </section>
  )
}
