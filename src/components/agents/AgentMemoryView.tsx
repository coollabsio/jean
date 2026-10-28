import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  ChevronRight,
  Copy,
  MoreHorizontal,
  Pencil,
  Search,
  Settings2,
  Thumbtack,
  Trash2,
  X,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
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
  activeFilterCount,
  describeMemoryChange,
  EMPTY_MEMORY_FILTERS,
  formatDay,
  formatJournalTime,
  groupJournalByDay,
  journalDayLabel,
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
import {
  AgentEmpty,
  AgentList,
  AgentLoading,
  AgentPanel,
  AgentSection,
  AgentTabBody,
  AGENT_ROW,
  AgentAddButton,
} from './agent-ui'

const KIND_LABELS: Record<MemoryKind, string> = {
  rule: 'Rule',
  fact: 'Fact',
  open_work: 'Open work',
}

const SCOPE_LABELS: Record<MemoryScope, string> = {
  user: 'About you',
  agent: 'Private',
  shared: 'Shared',
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
  const details = [
    memory.scope !== 'user'
      ? (SCOPE_LABELS[memory.scope] ?? memory.scope)
      : null,
    memory.pinned ? 'Pinned' : null,
    memory.projectId ? `Project ${memory.projectId}` : null,
    expired ? 'Expired' : null,
  ].filter(Boolean)
  const kindBadge = (
    <Badge variant="subtle">{KIND_LABELS[memory.kind] ?? memory.kind}</Badge>
  )
  const onError = (e: unknown) => toast.error(`Failed: ${e}`)

  return (
    <li
      className={cn(
        AGENT_ROW,
        'group flex items-start gap-2',
        expired && 'opacity-60'
      )}
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              rows={3}
              maxLength={MAX_CHARS}
              onChange={e => setDraft(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(memory.content)
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
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
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p
            className="whitespace-pre-wrap break-words text-sm text-foreground"
            title={`Memory #${memory.id}`}
          >
            {memory.content}
          </p>
        )}
        <div className="mt-1 flex">
          {details.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>{kindBadge}</span>
              </TooltipTrigger>
              <TooltipContent>{details.join(' · ')}</TooltipContent>
            </Tooltip>
          ) : (
            kindBadge
          )}
        </div>
      </div>
      {!editing && (
        <div className="flex shrink-0 gap-0.5 text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={memory.pinned ? 'Unpin' : 'Pin'}
                aria-pressed={memory.pinned}
                className={cn(
                  memory.pinned && 'text-warning hover:text-warning'
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
            </TooltipTrigger>
            <TooltipContent>{memory.pinned ? 'Unpin' : 'Pin'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Edit"
                onClick={() => setEditing(true)}
              >
                <Pencil />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Forget"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate({ agentId, memoryId: memory.id }, { onError })
                }
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Forget</TooltipContent>
          </Tooltip>
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
  empty: ReactNode
}) {
  if (!memories.length) return <AgentEmpty title={empty} />
  return (
    <AgentList>
      {memories.map(memory => (
        <MemoryRow key={memory.id} memory={memory} agentId={agentId} />
      ))}
    </AgentList>
  )
}

function ChangeRow({ change }: { change: AgentMemoryChange }) {
  return (
    <li className={cn(AGENT_ROW, 'flex flex-col gap-1')}>
      <p className="text-2xs text-muted-foreground">
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

function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 [&_[data-slot=native-select-wrapper]]:w-full">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
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
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [composer, setComposer] = useState<
    'fact' | 'memory' | 'journal' | null
  >(null)
  const [changesOpen, setChangesOpen] = useState(false)
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
  const allChanges = data?.memoryChanges ?? []
  const changes = visibleChanges(allChanges, changesExpanded)
  const filterCount = activeFilterCount(filters)
  const memoryLoading = isLoading || (searching && memoryQuery.isLoading)

  const patchFilter = (patch: Partial<MemorySearchFilters>) =>
    setFilters(current => ({ ...current, ...patch }))

  const toggleComposer = (next: 'fact' | 'memory' | 'journal') =>
    setComposer(current => (current === next ? null : next))

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
          setComposer(null)
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
          setComposer(null)
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
    <AgentTabBody>
      <div className="flex flex-col gap-2" data-testid="memory-search">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="memory-search"
              type="search"
              value={queryDraft}
              aria-label="Search memory and journal"
              placeholder="Search memory and journal"
              className="h-8 pl-8 text-xs md:text-xs"
              onChange={e => setQueryDraft(e.target.value)}
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant={filtersOpen || filterCount > 0 ? 'secondary' : 'ghost'}
                className="relative text-muted-foreground"
                aria-label={
                  filterCount > 0
                    ? `Filters (${filterCount} active)`
                    : 'Filters'
                }
                aria-expanded={filtersOpen}
                aria-controls="memory-filters"
                onClick={() => setFiltersOpen(value => !value)}
              >
                <Settings2 />
                {filterCount > 0 && (
                  <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
            </TooltipContent>
          </Tooltip>
          {searching && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label="Clear search and filters"
                  onClick={() => {
                    setQueryDraft('')
                    setFilters(EMPTY_MEMORY_FILTERS)
                  }}
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear search and filters</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label="More memory actions"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleExport}>
                <Copy />
                Copy as Markdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {filtersOpen && (
          <div
            id="memory-filters"
            className="grid grid-cols-2 gap-2 rounded-md bg-muted/30 p-2"
          >
            <FilterField label="Kind" htmlFor="memory-filter-kind">
              <NativeSelect
                id="memory-filter-kind"
                className="h-8 py-1"
                value={filters.kind}
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
            </FilterField>
            <FilterField label="Scope" htmlFor="memory-filter-scope">
              <NativeSelect
                id="memory-filter-scope"
                className="h-8 py-1"
                value={filters.scope}
                onChange={e =>
                  patchFilter({
                    scope: e.target.value as MemorySearchFilters['scope'],
                  })
                }
              >
                <NativeSelectOption value="">Any scope</NativeSelectOption>
                {(Object.keys(SCOPE_LABELS) as MemoryScope[]).map(item => (
                  <NativeSelectOption key={item} value={item}>
                    {SCOPE_LABELS[item]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FilterField>
            <FilterField label="Pinned" htmlFor="memory-filter-pinned">
              <NativeSelect
                id="memory-filter-pinned"
                className="h-8 py-1"
                value={filters.pinned}
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
            </FilterField>
            <FilterField label="From" htmlFor="memory-filter-from">
              <Input
                id="memory-filter-from"
                type="date"
                value={filters.from}
                className="h-8 text-sm"
                onChange={e => patchFilter({ from: e.target.value })}
              />
            </FilterField>
            <FilterField label="To" htmlFor="memory-filter-to">
              <Input
                id="memory-filter-to"
                type="date"
                value={filters.to}
                className="h-8 text-sm"
                onChange={e => patchFilter({ to: e.target.value })}
              />
            </FilterField>
            <FilterField label="Project" htmlFor="memory-filter-project">
              <Input
                id="memory-filter-project"
                value={filters.project}
                placeholder="Project id"
                className="h-8 text-sm"
                onChange={e => patchFilter({ project: e.target.value })}
              />
            </FilterField>
          </div>
        )}
        {searchError && (
          <p className="text-xs text-destructive" role="alert">
            Search failed: {String(searchError)}
          </p>
        )}
      </div>

      {showUserFactSection(filters) && (
        <AgentSection
          testId="user-facts"
          title="About you"
          count={userFacts.length}
          description="Facts every agent sees, like your name, timezone, and preferences."
          actions={
            <AgentAddButton
              open={composer === 'fact'}
              label="Add fact"
              onClick={() => toggleComposer('fact')}
            />
          }
        >
          {composer === 'fact' && (
            <AgentPanel>
              <Label htmlFor="user-fact" className="sr-only">
                Fact about you
              </Label>
              <Textarea
                id="user-fact"
                value={userFact}
                rows={2}
                maxLength={MAX_CHARS}
                placeholder="Timezone is Helsinki. Prefers short answers."
                onChange={e => setUserFact(e.target.value)}
                autoFocus
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
            </AgentPanel>
          )}
          {memoryLoading ? (
            <AgentLoading label="Loading memory…" />
          ) : (
            <MemoryList
              memories={userFacts}
              agentId={agent.id}
              empty={
                searching ? 'No matching facts.' : 'No facts about you yet.'
              }
            />
          )}
        </AgentSection>
      )}

      {showAgentMemorySection(filters) && (
        <AgentSection
          testId="agent-memory"
          title="Memory"
          count={rest.length}
          description="Rules, facts, and open work. Shared entries are visible to every agent."
          actions={
            <AgentAddButton
              open={composer === 'memory'}
              label="Add memory"
              onClick={() => toggleComposer('memory')}
            />
          }
        >
          {composer === 'memory' && (
            <AgentPanel>
              <Label htmlFor="new-memory" className="sr-only">
                New memory
              </Label>
              <Textarea
                id="new-memory"
                value={content}
                rows={2}
                maxLength={MAX_CHARS}
                placeholder="Ask before you merge pull requests in coolify."
                onChange={e => setContent(e.target.value)}
                autoFocus
              />
              <div className="flex flex-wrap items-center gap-3">
                <NativeSelect
                  className="h-8 py-1"
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
                  Add memory
                </Button>
              </div>
            </AgentPanel>
          )}
          {memoryLoading ? (
            <AgentLoading label="Loading memory…" />
          ) : (
            <MemoryList
              memories={rest}
              agentId={agent.id}
              empty={
                searching
                  ? 'No matching memories.'
                  : 'No memories yet. Tell the agent in Chat to remember something.'
              }
            />
          )}
        </AgentSection>
      )}

      <AgentSection
        testId="journal-timeline"
        title="Journal"
        count={journal.length}
        description="Dated history. Archived chats are stored here and can be recalled by text or date."
        actions={
          <AgentAddButton
            open={composer === 'journal'}
            label="Add entry"
            onClick={() => toggleComposer('journal')}
          />
        }
      >
        {composer === 'journal' && (
          <AgentPanel>
            <Label htmlFor="journal-entry" className="sr-only">
              Journal entry
            </Label>
            <Textarea
              id="journal-entry"
              value={journalText}
              rows={2}
              maxLength={MAX_JOURNAL_CHARS}
              placeholder="Decided to ship the orbit fix on Tuesday."
              onChange={e => setJournalText(e.target.value)}
              autoFocus
            />
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="date"
                aria-label="When"
                value={journalDay}
                className="h-8 w-auto text-sm"
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
          </AgentPanel>
        )}
        {searchingJournal && journalQuery.isLoading ? (
          <AgentLoading label="Loading journal…" />
        ) : journalGroups.length ? (
          <div className="flex flex-col gap-2">
            {journalGroups.map(group => (
              <div key={group.day} className="flex flex-col">
                <h4 className="px-2 pb-0.5 text-2xs font-medium text-muted-foreground/70">
                  {journalDayLabel(group.day)}
                </h4>
                <AgentList>
                  {group.entries.map((item: AgentJournalEntry) => (
                    <li key={item.id} className={cn(AGENT_ROW, 'flex gap-2')}>
                      <span className="w-9 shrink-0 pt-0.5 text-2xs tabular-nums text-muted-foreground">
                        {formatJournalTime(item.occurredAt)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                          {item.content}
                        </p>
                        <p className="text-2xs text-muted-foreground">
                          {[
                            journalSourceLabel(item.source),
                            item.projectId ? `Project ${item.projectId}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    </li>
                  ))}
                </AgentList>
              </div>
            ))}
          </div>
        ) : (
          <AgentEmpty
            title={
              searchingJournal
                ? 'No matching journal entries.'
                : 'No journal entries yet.'
            }
          />
        )}
      </AgentSection>

      <Collapsible
        open={changesOpen}
        onOpenChange={setChangesOpen}
        data-testid="memory-changes"
        className="flex flex-col gap-1.5"
      >
        <CollapsibleTrigger className="flex items-center gap-1 self-start rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronRight
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              changesOpen && 'rotate-90'
            )}
          />
          Recent changes
          <span className="font-normal tabular-nums text-muted-foreground/70">
            {allChanges.length}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-1">
          {changes.length ? (
            <AgentList>
              {changes.map(change => (
                <ChangeRow key={change.id} change={change} />
              ))}
            </AgentList>
          ) : (
            <AgentEmpty title="Edits, corrections, and forgotten entries show up here." />
          )}
          {allChanges.length > 8 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 self-start px-2 text-xs text-muted-foreground"
              onClick={() => setChangesExpanded(value => !value)}
            >
              {changesExpanded ? 'Show less' : `Show all ${allChanges.length}`}
            </Button>
          )}
        </CollapsibleContent>
      </Collapsible>
    </AgentTabBody>
  )
}
