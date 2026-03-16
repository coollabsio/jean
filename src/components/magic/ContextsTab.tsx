import { Loader2, Search } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  ContextItem,
  AttachedContextItem,
  SessionGroup,
  type SessionWithContext,
} from './LoadContextItems'
import type { SavedContext, AllSessionsEntry } from '@/types/chat'
import type { AttachedSavedContext } from '@/types/github'

interface ContextsTabProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  // Attached contexts (loaded into this worktree)
  attachedContexts: AttachedSavedContext[]
  isLoadingAttachedContexts: boolean
  hasAttachedContexts: boolean
  loadingSlugs: Set<string>
  removingSlugs: Set<string>
  onViewAttachedContext: (ctx: AttachedSavedContext) => void
  onRemoveAttachedContext: (slug: string) => void
  // Available contexts (not yet attached)
  filteredContexts: SavedContext[]
  filteredEntries: AllSessionsEntry[]
  isLoading: boolean
  error: Error | null
  hasContexts: boolean
  hasSessions: boolean
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  editingFilename: string | null
  editValue: string
  setEditValue: (value: string) => void
  editInputRef: React.RefObject<HTMLInputElement | null>
  generatingSessionId: string | null
  onAttachContext: (context: SavedContext) => void
  onViewContext: (e: React.MouseEvent, context: SavedContext) => void
  onStartEdit: (e: React.MouseEvent, context: SavedContext) => void
  onRenameSubmit: (filename: string) => void
  onRenameKeyDown: (e: React.KeyboardEvent, filename: string) => void
  onDeleteContext: (e: React.MouseEvent, context: SavedContext) => void
  onSessionClick: (sessionWithContext: SessionWithContext) => void
}

export function ContextsTab({
  searchQuery,
  setSearchQuery,
  searchInputRef,
  // Attached contexts
  attachedContexts,
  isLoadingAttachedContexts,
  hasAttachedContexts,
  loadingSlugs,
  removingSlugs,
  onViewAttachedContext,
  onRemoveAttachedContext,
  // Available contexts
  filteredContexts,
  filteredEntries,
  isLoading,
  error,
  hasContexts,
  hasSessions,
  selectedIndex,
  setSelectedIndex,
  editingFilename,
  editValue,
  setEditValue,
  editInputRef,
  generatingSessionId,
  onAttachContext,
  onViewContext,
  onStartEdit,
  onRenameSubmit,
  onRenameKeyDown,
  onDeleteContext,
  onSessionClick,
}: ContextsTabProps) {
  const isEmpty =
    !hasContexts && !hasSessions && !hasAttachedContexts && !isLoading && !error

  // Calculate flat index for sessions
  let sessionStartIndex = filteredContexts.length

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Attached Contexts section (like loaded issues/PRs) */}
      {isLoadingAttachedContexts ? (
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        </div>
      ) : hasAttachedContexts ? (
        <div className="border-b border-border">
          <div className="px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/30">
            Attached Contexts
          </div>
          <div className="max-h-[150px] overflow-y-auto">
            {attachedContexts.map(ctx => (
              <AttachedContextItem
                key={ctx.slug}
                context={ctx}
                isRemoving={removingSlugs.has(ctx.slug)}
                onView={() => onViewAttachedContext(ctx)}
                onRemove={() => onRemoveAttachedContext(ctx.slug)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Search section */}
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="text"
            placeholder="Search contexts and sessions..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-center py-8 text-destructive">
            Failed to load saved contexts
          </div>
        ) : isEmpty ? (
          <div className="text-center py-8 text-muted-foreground">
            No saved contexts or sessions available.
            <br />
            <span className="text-sm">
              Use &quot;Save Context&quot; to save a conversation summary.
            </span>
          </div>
        ) : (
          <div className="py-1">
            {/* Available Contexts - narrow list style like PRs */}
            {hasContexts && (
              <>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/30">
                  Available Contexts
                </div>
                {filteredContexts.map((context, index) => (
                  <ContextItem
                    key={context.id}
                    context={context}
                    index={index}
                    isSelected={index === selectedIndex}
                    isLoading={loadingSlugs.has(context.slug)}
                    isEditing={editingFilename === context.filename}
                    editValue={editValue}
                    setEditValue={setEditValue}
                    editInputRef={editInputRef}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => onAttachContext(context)}
                    onView={e => onViewContext(e, context)}
                    onStartEdit={e => onStartEdit(e, context)}
                    onRenameSubmit={() => onRenameSubmit(context.filename)}
                    onRenameKeyDown={e => onRenameKeyDown(e, context.filename)}
                    onDelete={e => onDeleteContext(e, context)}
                  />
                ))}
              </>
            )}

            {/* Sessions Section - narrow list style */}
            {hasSessions && (
              <>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/30 mt-2">
                  Generate from Session
                </div>
                {filteredEntries.map(entry => {
                  const entryElement = (
                    <SessionGroup
                      key={entry.worktree_id}
                      entry={entry}
                      generatingSessionId={generatingSessionId}
                      onSessionClick={onSessionClick}
                      selectedIndex={selectedIndex}
                      sessionStartIndex={sessionStartIndex}
                      setSelectedIndex={setSelectedIndex}
                    />
                  )
                  // eslint-disable-next-line react-hooks/immutability
                  sessionStartIndex += entry.sessions.length
                  return entryElement
                })}
              </>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
