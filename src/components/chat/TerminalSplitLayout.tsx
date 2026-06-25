import { Fragment, memo, useState } from 'react'
import { GripVertical, SquareArrowOutUpRight, X } from 'lucide-react'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  firstLeafId,
  type SplitNode,
  type SplitOrientation,
} from '@/lib/terminal-split'
import { cn } from '@/lib/utils'
import { useTerminalStore, type TerminalInstance } from '@/store/terminal-store'
import { InlineRename, TerminalTabContent } from './TerminalView'

interface TerminalSplitLayoutProps {
  worktreeId: string
  worktreePath: string
  layout: SplitNode
  focusedTerminalId: string | undefined
  isWorktreeActive: boolean
  /** Show per-pane chrome (grip handle, detach, close) — when >1 pane. */
  showPaneChrome: boolean
  /** Stop the PTY + dispose, then prune the pane. Provided by the host view. */
  onClosePane: (terminalId: string) => void
  /** Pop a pane out of the split into its own view (tab). */
  onDetachPane: (terminalId: string) => void
  /** Rename a pane's terminal (double-click its title). */
  onRenameTerminal: (terminalId: string, label: string) => void
  /** A tab or pane was dropped on `targetTerminalId`. `payload` is the raw
   * drag data (`pane:<id>` or `group:<id>`). Undefined disables drag-to-merge
   * / drag-to-move (web/mobile). */
  onPaneDrop?: (
    targetTerminalId: string,
    orientation: SplitOrientation,
    payload: string
  ) => void
  /** Lookup map shared by the host view (avoids rebuilding it per layout). */
  terminalsById: Map<string, TerminalInstance>
}

/** Stable React key / panel id for a child subtree (its top-left leaf). */
function nodeKey(node: SplitNode): string {
  return node.type === 'leaf' ? node.terminalId : firstLeafId(node)
}

interface SharedPaneProps {
  worktreeId: string
  worktreePath: string
  focusedTerminalId: string | undefined
  isWorktreeActive: boolean
  showPaneChrome: boolean
  onClosePane: (terminalId: string) => void
  onDetachPane: (terminalId: string) => void
  onRenameTerminal: (terminalId: string, label: string) => void
  onPaneDrop?: TerminalSplitLayoutProps['onPaneDrop']
  terminalsById: Map<string, TerminalInstance>
}

/** One leaf pane: a title bar (label + controls) above the terminal, plus a
 * focus ring and a drop zone. The title bar only shows in multi-pane views. */
const SplitPane = memo(function SplitPane({
  terminalId,
  worktreeId,
  worktreePath,
  focusedTerminalId,
  isWorktreeActive,
  showPaneChrome,
  onClosePane,
  onDetachPane,
  onRenameTerminal,
  onPaneDrop,
  terminalsById,
}: SharedPaneProps & { terminalId: string }) {
  const terminal = terminalsById.get(terminalId)
  const dragTerminalId = useTerminalStore(state => state.dragTerminalId)
  const isRunning = useTerminalStore(state =>
    state.runningTerminals.has(terminalId)
  )
  const [dropOrientation, setDropOrientation] =
    useState<SplitOrientation | null>(null)
  const [editing, setEditing] = useState(false)
  if (!terminal) return null

  const isFocused = terminalId === focusedTerminalId
  // Only accept a drop when it would actually do something: there is a drag in
  // progress and it isn't this very pane (dropping a tab/pane on itself is a
  // no-op, so we don't show a hint or accept it).
  const canAcceptDrop =
    !!onPaneDrop && dragTerminalId !== null && dragTerminalId !== terminalId

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptDrop) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const ratioY = rect.height ? (e.clientY - rect.top) / rect.height : 0.5
    // Top/bottom band ⇒ stack (vertical); middle band ⇒ side-by-side.
    setDropOrientation(ratioY < 0.3 || ratioY > 0.7 ? 'vertical' : 'horizontal')
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDropOrientation(null)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!onPaneDrop) return
    e.preventDefault()
    const payload = e.dataTransfer.getData('text/plain')
    setDropOrientation(null)
    useTerminalStore.getState().setDragTerminal(null)
    if (canAcceptDrop && payload) {
      onPaneDrop(terminalId, dropOrientation ?? 'horizontal', payload)
    }
  }

  return (
    <div
      data-terminal-pane={terminalId}
      className={cn(
        'group/pane relative flex h-full w-full flex-col overflow-hidden transition-colors',
        showPaneChrome && 'ring-1 ring-inset',
        showPaneChrome && (isFocused ? 'ring-primary/60' : 'ring-transparent')
      )}
      // Capture so focusing a pane wins before xterm swallows the mousedown.
      onMouseDownCapture={() =>
        useTerminalStore.getState().setActiveTerminal(worktreeId, terminalId)
      }
      onDragOver={onPaneDrop ? handleDragOver : undefined}
      onDragLeave={onPaneDrop ? handleDragLeave : undefined}
      onDrop={onPaneDrop ? handleDrop : undefined}
    >
      {showPaneChrome && (
        <div
          // The whole title bar is the drag handle for moving the pane.
          draggable={!editing}
          onDragStart={e => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', `pane:${terminalId}`)
            useTerminalStore.getState().setDragTerminal(terminalId)
          }}
          onDragEnd={() => useTerminalStore.getState().setDragTerminal(null)}
          className={cn(
            'flex h-6 shrink-0 items-center gap-1 border-b border-border px-1.5 text-xs',
            isFocused
              ? 'bg-muted text-foreground'
              : 'bg-muted/30 text-muted-foreground',
            !editing && 'cursor-grab active:cursor-grabbing'
          )}
          title="Drag to move pane"
        >
          <GripVertical className="h-3 w-3 shrink-0 opacity-50" />
          {isRunning && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
          )}
          {editing ? (
            <InlineRename
              value={terminal.label}
              onCommit={name => {
                onRenameTerminal(terminalId, name)
                setEditing(false)
              }}
              onCancel={() => setEditing(false)}
              className="flex-1"
              ariaLabel="Rename pane"
            />
          ) : (
            <span
              className="flex-1 truncate"
              title="Double-click to rename"
              onDoubleClick={e => {
                e.stopPropagation()
                setEditing(true)
              }}
            >
              {terminal.label}
            </span>
          )}
          <button
            type="button"
            aria-label="Detach pane to new tab"
            title="Detach to new tab"
            onClick={e => {
              e.stopPropagation()
              onDetachPane(terminalId)
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <SquareArrowOutUpRight className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label="Close pane"
            onClick={e => {
              e.stopPropagation()
              onClosePane(terminalId)
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-red-400"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div className="min-h-0 w-full flex-1">
        <TerminalTabContent
          terminal={terminal}
          worktreeId={worktreeId}
          worktreePath={worktreePath}
          isVisible
          isFocused={isFocused}
          isWorktreeActive={isWorktreeActive}
        />
      </div>
      {/* Drop hint: the half where the dragged terminal will land. */}
      {dropOrientation && (
        <div
          className={cn(
            'pointer-events-none absolute z-20 bg-primary/20 ring-2 ring-inset ring-primary/70',
            dropOrientation === 'horizontal'
              ? 'inset-y-0 right-0 w-1/2'
              : 'inset-x-0 bottom-0 h-1/2'
          )}
        />
      )}
    </div>
  )
})

/** Recursively renders a split node as nested resizable panel groups. */
function SplitNodeView({
  node,
  path,
  shared,
}: {
  node: SplitNode
  path: number[]
  shared: SharedPaneProps
}) {
  if (node.type === 'leaf') {
    return <SplitPane terminalId={node.terminalId} {...shared} />
  }

  const childCount = node.children.length
  return (
    <ResizablePanelGroup
      direction={node.orientation}
      onLayout={sizes =>
        useTerminalStore.getState().setPaneSizes(shared.worktreeId, path, sizes)
      }
    >
      {node.children.map((child, index) => (
        <Fragment key={nodeKey(child)}>
          {index > 0 && (
            <ResizableHandle
              withHandle
              // Explicit thickness per known orientation so the divider is
              // clearly visible from the first render (not just after a resize).
              className={cn(
                'bg-border',
                node.orientation === 'vertical'
                  ? 'h-0.5 w-full'
                  : 'h-full w-0.5'
              )}
            />
          )}
          <ResizablePanel
            id={nodeKey(child)}
            order={index}
            defaultSize={node.sizes?.[index] ?? 100 / childCount}
            minSize={10}
          >
            <SplitNodeView
              node={child}
              path={[...path, index]}
              shared={shared}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  )
}

/**
 * Renders one terminal view's layout (1+ panes). Each leaf attaches its own
 * terminal PTY; the focused pane owns the keyboard. Terminals in other views
 * are kept mounted (hidden) by the parent TerminalView to preserve buffers.
 */
export function TerminalSplitLayout({
  worktreeId,
  worktreePath,
  layout,
  focusedTerminalId,
  isWorktreeActive,
  showPaneChrome,
  onClosePane,
  onDetachPane,
  onRenameTerminal,
  onPaneDrop,
  terminalsById,
}: TerminalSplitLayoutProps) {
  const shared: SharedPaneProps = {
    worktreeId,
    worktreePath,
    focusedTerminalId,
    isWorktreeActive,
    showPaneChrome,
    onClosePane,
    onDetachPane,
    onRenameTerminal,
    onPaneDrop,
    terminalsById,
  }

  return (
    <div className="h-full w-full">
      <SplitNodeView node={layout} path={[]} shared={shared} />
    </div>
  )
}
