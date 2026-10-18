import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Copy, Pencil, Thumbtack, Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import {
  exportAgentMemory,
  useAgentDetails,
  useDeleteAgentMemory,
  useSaveAgentJournal,
  useSaveAgentMemory,
  useSearchAgentJournal,
  useSearchAgentMemory,
  useSupersedeAgentMemory,
  useUpdateAgentMemory,
  type AgentJournalEntry,
  type AgentMemory,
  type AgentMemoryChange,
  type AgentSummary,
  type MemoryKind,
  type MemoryScope,
} from '@/services/agents'
import {
  describeMemoryChange,
  EMPTY_MEMORY_FILTERS,
  formatDay,
  formatJournalTime,
  groupJournalByDay,
  journalSearchActive,
  journalSearchRequest,
  journalSourceLabel,
  memorySearchActive,
  memorySearchRequest,
  partitionMemories,
  showAgentMemorySection,
  showUserFactSection,
  visibleChanges,
  type MemorySearchFilters,
} from './memory-view'

const KIND_LABELS: Record<MemoryKind, string> = {
  rule: 'Rule',
  fact: 'Fact',
  open_work: 'Open work',
}

const MAX_CHARS = 1000
const MAX_JOURNAL_CHARS = 2000

function MemoryRow({
  memory,
  agentId,
}: {
  memory: AgentMemory
  agentId: string
}) {
  const update = useUpdateAgentMemory()
  const correct = useSupersedeAgentMemory()
  const remove = useDeleteAgentMemory()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.content)
  const [renderedAt] = useState(() => Date.now())
  const expired =
    memory.expiresAt !== null && memory.expiresAt * 1000 < renderedAt
  const isFact = memory.kind === 'fact'
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
          {memory.scope === 'user' && (
            <span className="rounded bg-muted px-1.5 py-0.5">about you</span>
          )}
          {memory.scope === 'shared' && (
            <span className="rounded bg-muted px-1.5 py-0.5">shared</span>
          )}
          {memory.scope === 'agent' && (
            <span className="rounded bg-muted px-1.5 py-0.5">private</span>
          )}
          {memory.pinned && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              pinned
            </span>
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
                disabled={
                  !draft.trim() || update.isPending || correct.isPending
                }
                onClick={() => {
                  if (isFact) {
                    if (draft.trim() === memory.content) {
                      setEditing(false)
                      return
                    }
                    correct.mutate(
                      { agentId, memoryId: memory.id, content: draft },
                      { onSuccess: () => setEditing(false), onError }
                    )
                    return
                  }
                  update.mutate(
                    { agentId, memoryId: memory.id, patch: { content: draft } },
                    { onSuccess: () => setEditing(false), onError }
                  )
                }}
              >
                {isFact ? 'Correct' : 'Save'}
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
            aria-label={isFact ? 'Correct' : 'Edit'}
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Forget"
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

function MemoryList({
  memories,
  agentId,
  empty,
}: {
  memories: AgentMemory[]
  agentId: string
  empty: string
}) {
  if (!memories.length) {
    return <p className="text-xs text-muted-foreground">{empty}</p>
  }
  return (
    <ul className="space-y-2">
      {memories.map(memory => (
        <MemoryRow key={memory.id} memory={memory} agentId={agentId} />
      ))}
    </ul>
  )
}

function ChangeRow({ change }: { change: AgentMemoryChange }) {
  return (
    <li className="space-y-1 rounded-md border px-3 py-2">
      <p className="text-[11px] text-muted-foreground">
        {describeMemoryChange(change)} · {formatDay(change.createdAt)}{' '}
        {formatJournalTime(change.createdAt)}
      </p>
      {change.beforeContent && (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground line-through">
          {change.beforeContent}
        </p>
      )}
      {change.afterContent && (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
          {change.afterContent}
        </p>
      )}
    </li>
  )
}

/** The agent's memory: search, user facts, private and shared entries, journal. */
export function AgentMemoryView({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const save = useSaveAgentMemory()
  const saveJournal = useSaveAgentJournal()
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<MemoryKind>('rule')
  const [shared, setShared] = useState(false)
  const [userFact, setUserFact] = useState('')
  const [journalText, setJournalText] = useState('')
  const [journalDay, setJournalDay] = useState('')
  const [filters, setFilters] =
    useState<MemorySearchFilters>(EMPTY_MEMORY_FILTERS)
  const [queryDraft, setQueryDraft] = useState('')
  const [changesExpanded, setChangesExpanded] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters(current =>
        current.query === queryDraft
          ? current
          : { ...current, query: queryDraft }
      )
    }, 200)
    return () => window.clearTimeout(timer)
  }, [queryDraft])

  const memoryRequest = useMemo(() => memorySearchRequest(filters), [filters])
  const journalRequest = useMemo(() => journalSearchRequest(filters), [filters])
  const searching = memorySearchActive(filters)
  const searchingJournal = journalSearchActive(filters)
  const memoryQuery = useSearchAgentMemory(agent.id, memoryRequest, searching)
  const journalQuery = useSearchAgentJournal(
    agent.id,
    journalRequest,
    searchingJournal
  )

  const searchError =
    (searching && memoryQuery.error) || (searchingJournal && journalQuery.error)
  const memories = searching ? (memoryQuery.data ?? []) : (data?.memories ?? [])
  const journal = searchingJournal
    ? (journalQuery.data ?? [])
    : (data?.journal ?? [])
  const { userFacts, rest } = partitionMemories(memories)
  const journalGroups = groupJournalByDay(journal)
  const changes = visibleChanges(data?.memoryChanges ?? [], changesExpanded)

  const patchFilter = (patch: Partial<MemorySearchFilters>) =>
    setFilters(current => ({ ...current, ...patch }))

  const handleAdd = (
    scope: MemoryScope,
    text: string,
    memoryKind: MemoryKind
  ) =>
    save.mutate(
      {
        agentId: agent.id,
        content: text,
        kind: memoryKind,
        scope,
        pinned: false,
      },
      {
        onSuccess: () => {
          if (scope === 'user') setUserFact('')
          else setContent('')
        },
        onError: e => toast.error(`Failed to save memory: ${e}`),
      }
    )

  const handleJournal = () => {
    const occurredAt = journalDay
      ? Math.floor(new Date(`${journalDay}T12:00:00`).getTime() / 1000)
      : null
    saveJournal.mutate(
      {
        agentId: agent.id,
        content: journalText,
        occurredAt: Number.isFinite(occurredAt) ? occurredAt : null,
      },
      {
        onSuccess: () => {
          setJournalText('')
          setJournalDay('')
        },
        onError: e => toast.error(`Failed to save journal entry: ${e}`),
      }
    )
  }

  const handleExport = async () => {
    try {
      await copyToClipboard(await exportAgentMemory(agent.id))
      toast.success('Memory copied as Markdown')
    } catch (e) {
      toast.error(`Failed to export memory: ${e}`)
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
      <div className="space-y-2" data-testid="memory-search">
        <Label htmlFor="memory-search">Search memory and journal</Label>
        <Input
          id="memory-search"
          value={queryDraft}
          placeholder="orbit deploy, timezone, a decision…"
          onChange={e => setQueryDraft(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            value={filters.kind}
            aria-label="Kind"
            onChange={e =>
              patchFilter({
                kind: e.target.value as MemorySearchFilters['kind'],
              })
            }
          >
            <NativeSelectOption value="">Any kind</NativeSelectOption>
            {(Object.keys(KIND_LABELS) as MemoryKind[]).map(item => (
              <NativeSelectOption key={item} value={item}>
                {KIND_LABELS[item]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            value={filters.scope}
            aria-label="Scope"
            onChange={e =>
              patchFilter({
                scope: e.target.value as MemorySearchFilters['scope'],
              })
            }
          >
            <NativeSelectOption value="">Any scope</NativeSelectOption>
            <NativeSelectOption value="user">About you</NativeSelectOption>
            <NativeSelectOption value="agent">Private</NativeSelectOption>
            <NativeSelectOption value="shared">Shared</NativeSelectOption>
          </NativeSelect>
          <NativeSelect
            value={filters.pinned}
            aria-label="Pinned"
            onChange={e =>
              patchFilter({
                pinned: e.target.value as MemorySearchFilters['pinned'],
              })
            }
          >
            <NativeSelectOption value="">Pinned or not</NativeSelectOption>
            <NativeSelectOption value="yes">Pinned</NativeSelectOption>
            <NativeSelectOption value="no">Not pinned</NativeSelectOption>
          </NativeSelect>
          <Input
            type="date"
            aria-label="From"
            value={filters.from}
            className="w-auto"
            onChange={e => patchFilter({ from: e.target.value })}
          />
          <Input
            type="date"
            aria-label="To"
            value={filters.to}
            className="w-auto"
            onChange={e => patchFilter({ to: e.target.value })}
          />
          <Input
            aria-label="Project"
            value={filters.project}
            placeholder="Project id"
            className="w-36"
            onChange={e => patchFilter({ project: e.target.value })}
          />
          {searching && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQueryDraft('')
                setFilters(EMPTY_MEMORY_FILTERS)
              }}
            >
              Clear
            </Button>
          )}
        </div>
        {searchError && (
          <p className="text-xs text-destructive">
            Search failed: {String(searchError)}
          </p>
        )}
      </div>

      {showUserFactSection(filters) && (
        <section className="space-y-2" data-testid="user-facts">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            About you ({userFacts.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            Facts every agent sees: name, timezone, preferences. Shared memory
            below is working notes for all agents, not who you are.
          </p>
          <div className="space-y-2 rounded-md border px-3 py-3">
            <Label htmlFor="user-fact">Add a fact about you</Label>
            <Textarea
              id="user-fact"
              value={userFact}
              rows={2}
              maxLength={MAX_CHARS}
              placeholder="Timezone is Helsinki. Prefers short answers."
              onChange={e => setUserFact(e.target.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!userFact.trim() || save.isPending}
                onClick={() => handleAdd('user', userFact, 'fact')}
              >
                Add fact
              </Button>
            </div>
          </div>
          {isLoading || (searching && memoryQuery.isLoading) ? (
            <p className="text-xs text-muted-foreground">Loading memory…</p>
          ) : (
            <MemoryList
              memories={userFacts}
              agentId={agent.id}
              empty="No facts about you yet."
            />
          )}
        </section>
      )}

      {showAgentMemorySection(filters) && (
        <section className="space-y-2" data-testid="agent-memory">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Memory ({rest.length})
            </h3>
            <Button size="sm" variant="ghost" onClick={handleExport}>
              <Copy />
              Copy as Markdown
            </Button>
          </div>
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
                {(Object.keys(KIND_LABELS) as MemoryKind[]).map(item => (
                  <NativeSelectOption key={item} value={item}>
                    {KIND_LABELS[item]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={shared}
                  onCheckedChange={value => setShared(value === true)}
                />
                Shared with all agents
              </label>
              <Button
                size="sm"
                className="ml-auto"
                disabled={!content.trim() || save.isPending}
                onClick={() =>
                  handleAdd(shared ? 'shared' : 'agent', content, kind)
                }
              >
                Add
              </Button>
            </div>
          </div>
          {isLoading || (searching && memoryQuery.isLoading) ? (
            <p className="text-xs text-muted-foreground">Loading memory…</p>
          ) : (
            <MemoryList
              memories={rest}
              agentId={agent.id}
              empty={
                searching
                  ? 'No matching memories.'
                  : 'No memories yet. The agent saves rules and facts with memory_save, or you add them here.'
              }
            />
          )}
        </section>
      )}

      <section className="space-y-2" data-testid="journal-timeline">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Journal ({journal.length})
        </h3>
        <p className="text-xs text-muted-foreground">
          Dated history of what happened. Archived chats are stored here so they
          can be recalled by text or date.
        </p>
        <div className="space-y-2 rounded-md border px-3 py-3">
          <Label htmlFor="journal-entry">Add journal entry</Label>
          <Textarea
            id="journal-entry"
            value={journalText}
            rows={2}
            maxLength={MAX_JOURNAL_CHARS}
            placeholder="Decided to ship the orbit fix on Tuesday."
            onChange={e => setJournalText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="date"
              aria-label="When"
              value={journalDay}
              className="w-auto"
              onChange={e => setJournalDay(e.target.value)}
            />
            <Button
              size="sm"
              className="ml-auto"
              disabled={!journalText.trim() || saveJournal.isPending}
              onClick={handleJournal}
            >
              Add entry
            </Button>
          </div>
        </div>
        {searchingJournal && journalQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading journal…</p>
        ) : journalGroups.length ? (
          <div className="space-y-4">
            {journalGroups.map(group => (
              <div key={group.day} className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {group.day}
                </h4>
                <ul className="space-y-2">
                  {group.entries.map((item: AgentJournalEntry) => (
                    <li
                      key={item.id}
                      className="space-y-1 rounded-md border px-3 py-2"
                    >
                      <p className="text-[11px] text-muted-foreground">
                        {formatJournalTime(item.occurredAt)} ·{' '}
                        {journalSourceLabel(item.source)}
                        {item.projectId ? ` · project ${item.projectId}` : ''}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                        {item.content}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {searchingJournal
              ? 'No matching journal entries.'
              : 'No journal entries yet.'}
          </p>
        )}
      </section>

      <section className="space-y-2" data-testid="memory-changes">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent changes ({data?.memoryChanges.length ?? 0})
        </h3>
        {changes.length ? (
          <ul className="space-y-2">
            {changes.map(change => (
              <ChangeRow key={change.id} change={change} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Edits, corrections, and forgotten entries show up here.
          </p>
        )}
        {(data?.memoryChanges.length ?? 0) > 8 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setChangesExpanded(value => !value)}
          >
            {changesExpanded ? 'Show less' : 'Show all'}
          </Button>
        )}
      </section>
    </div>
  )
}
