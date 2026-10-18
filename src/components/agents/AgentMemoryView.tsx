import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, Pencil, Thumbtack, Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import {
  exportAgentMemory,
  useAgentDetails,
  useDeleteAgentMemory,
  useSaveAgentMemory,
  useUpdateAgentMemory,
  type AgentMemory,
  type AgentSummary,
  type MemoryKind,
} from '@/services/agents'

const KIND_LABELS: Record<MemoryKind, string> = {
  rule: 'Rule',
  fact: 'Fact',
  open_work: 'Open work',
}

const MAX_CHARS = 1000

function MemoryRow({
  memory,
  agentId,
}: {
  memory: AgentMemory
  agentId: string
}) {
  const update = useUpdateAgentMemory()
  const remove = useDeleteAgentMemory()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.content)
  const [renderedAt] = useState(() => Date.now())
  const expired =
    memory.expiresAt !== null && memory.expiresAt * 1000 < renderedAt
  const onError = (e: unknown) => toast.error(`Failed: ${e}`)

  return (
    <li
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2',
        expired && 'opacity-60'
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5">
            {KIND_LABELS[memory.kind] ?? memory.kind}
          </span>
          {memory.pinned && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              pinned
            </span>
          )}
          {memory.agentId === null && (
            <span className="rounded bg-muted px-1.5 py-0.5">shared</span>
          )}
          {memory.projectId && (
            <span className="rounded bg-muted px-1.5 py-0.5">
              project {memory.projectId}
            </span>
          )}
          {expired && <span>expired</span>}
          <span>#{memory.id}</span>
        </p>
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              rows={3}
              maxLength={MAX_CHARS}
              onChange={e => setDraft(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!draft.trim() || update.isPending}
                onClick={() =>
                  update.mutate(
                    { agentId, memoryId: memory.id, patch: { content: draft } },
                    { onSuccess: () => setEditing(false), onError }
                  )
                }
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(memory.content)
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {memory.content}
          </p>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={memory.pinned ? 'Unpin' : 'Pin'}
            aria-pressed={memory.pinned}
            className={cn(
              memory.pinned &&
                'text-amber-600 hover:text-amber-600 dark:text-amber-400'
            )}
            onClick={() =>
              update.mutate(
                {
                  agentId,
                  memoryId: memory.id,
                  patch: { pinned: !memory.pinned },
                },
                { onError }
              )
            }
          >
            <Thumbtack />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Edit"
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate({ agentId, memoryId: memory.id }, { onError })
            }
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  )
}

/** The agent's memory (own + shared): add, edit, pin, delete, export. */
export function AgentMemoryView({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const save = useSaveAgentMemory()
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<MemoryKind>('rule')
  const [shared, setShared] = useState(false)

  const handleAdd = () =>
    save.mutate(
      { agentId: agent.id, content, kind, shared, pinned: false },
      {
        onSuccess: () => setContent(''),
        onError: e => toast.error(`Failed to save memory: ${e}`),
      }
    )

  const handleExport = async () => {
    try {
      await copyToClipboard(await exportAgentMemory(agent.id))
      toast.success('Memory copied as Markdown')
    } catch (e) {
      toast.error(`Failed to export memory: ${e}`)
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <div className="space-y-2 rounded-md border px-3 py-3">
        <Label htmlFor="new-memory">Add memory</Label>
        <Textarea
          id="new-memory"
          value={content}
          rows={2}
          maxLength={MAX_CHARS}
          placeholder="Ask before you merge pull requests in coolify."
          onChange={e => setContent(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <NativeSelect
            value={kind}
            onChange={e => setKind(e.target.value as MemoryKind)}
            aria-label="Kind"
          >
            {(Object.keys(KIND_LABELS) as MemoryKind[]).map(k => (
              <NativeSelectOption key={k} value={k}>
                {KIND_LABELS[k]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={shared}
              onCheckedChange={v => setShared(v === true)}
            />
            Shared with all agents
          </label>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!content.trim() || save.isPending}
            onClick={handleAdd}
          >
            Add
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Memory ({data?.memories.length ?? 0})
        </h3>
        <Button size="sm" variant="ghost" onClick={handleExport}>
          <Copy />
          Copy as Markdown
        </Button>
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading memory…</p>
      ) : data?.memories.length ? (
        <ul className="space-y-2">
          {data.memories.map(memory => (
            <MemoryRow key={memory.id} memory={memory} agentId={agent.id} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No memories yet. The agent saves rules and facts with memory_save, or
          you add them here.
        </p>
      )}
    </div>
  )
}
