import { useCallback } from 'react'
import {
  Folder,
  Globe,
  Play,
  Plus,
  Terminal,
  X,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { OpenInButton } from '@/components/open-in/OpenInButton'
import { TerminalView } from '@/components/chat/TerminalView'
import { BrowserView } from '@/components/browser/BrowserView'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { useIsMobile } from '@/hooks/use-mobile'
import { resolveRightPanelWorktreeId } from '@/lib/right-panel'
import { useUIStore, type RightPanelTab } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useBrowserStore } from '@/store/browser-store'
import {
  usePackageScripts,
  useProjects,
  useWorktree,
  type PackageScript,
} from '@/services/projects'

// The menu's first-letter typeahead matches each shortcut letter.
const TABS: {
  id: RightPanelTab
  label: string
  icon: typeof Folder
  shortcut: string
}[] = [
  { id: 'files', label: 'Files', icon: Folder, shortcut: 'F' },
  { id: 'terminal', label: 'Terminal', icon: Terminal, shortcut: 'T' },
  { id: 'browser', label: 'Browser', icon: Globe, shortcut: 'B' },
  { id: 'scripts', label: 'Scripts', icon: Play, shortcut: 'S' },
]

function useRightPanelWorktreeId(): string | null {
  const sessionChatModalOpen = useUIStore(state => state.sessionChatModalOpen)
  const sessionChatModalWorktreeId = useUIStore(
    state => state.sessionChatModalWorktreeId
  )
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  return resolveRightPanelWorktreeId({
    sessionChatModalOpen,
    sessionChatModalWorktreeId,
    activeWorktreeId,
    selectedWorktreeId,
  })
}

/** Open a tab. Terminal and browser go through their stores so every
 * open path (menu, shortcut, script run) behaves the same. */
function selectTab(tab: RightPanelTab, worktreeId: string | null) {
  if (tab === 'terminal' && worktreeId) {
    useTerminalStore.getState().setModalTerminalOpen(worktreeId, true)
  } else if (tab === 'browser' && worktreeId) {
    useBrowserStore.getState().setModalOpen(worktreeId, true)
  } else {
    useUIStore.getState().openRightPanelTab(tab)
  }
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function ScriptsTab({
  worktreeId,
  worktreePath,
}: {
  worktreeId: string
  worktreePath: string
}) {
  const { data: scripts = [], isLoading } = usePackageScripts(worktreePath, {
    worktreeId,
  })

  const handleRun = useCallback(
    (script: PackageScript) => {
      useTerminalStore
        .getState()
        .addTerminal(worktreeId, script.command, script.name, {
          commandArgs: script.args,
        })
      useTerminalStore.getState().setModalTerminalOpen(worktreeId, true)
    },
    [worktreeId]
  )

  if (isLoading) return <EmptyState>Loading scripts…</EmptyState>
  if (scripts.length === 0) {
    return <EmptyState>No package.json scripts in this worktree.</EmptyState>
  }

  return (
    <ScrollArea className="h-full">
      <ul className="flex flex-col p-1" aria-label="Scripts">
        {scripts.map(script => (
          <li key={script.name}>
            <button
              type="button"
              onClick={() => handleRun(script)}
              aria-label={`Run ${script.name}`}
              className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
            >
              <Play className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {script.name}
              </span>
              <span className="min-w-0 max-w-[50%] truncate font-mono text-2xs text-muted-foreground">
                {[script.command, ...script.args].join(' ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  )
}

/**
 * Right side panel with tabs for the worktree: files, terminal, browser and
 * package scripts. Visibility is `fileBrowserVisible` in the UI store.
 */
export function RightPanel() {
  const tab = useUIStore(state => state.rightPanelTab)
  const openTabs = useUIStore(state => state.rightPanelOpenTabs)
  const isMobile = useIsMobile()
  const panelWidth = useUIStore(state => state.fileBrowserSize)
  const worktreeId = useRightPanelWorktreeId()
  const { data: worktree } = useWorktree(worktreeId)
  const { data: projects = [] } = useProjects()
  const registeredPath = useChatStore(state =>
    worktreeId ? state.worktreePaths[worktreeId] : undefined
  )
  const worktreePath = worktree?.path ?? registeredPath ?? null
  const project = worktree
    ? projects.find(p => p.id === worktree.project_id)
    : undefined
  const isServer = !!project?.server

  const canShowWorktreeTab = !!worktreeId && !!worktreePath
  const available = TABS.filter(t => {
    if (t.id === 'browser') return isNativeApp() && !isServer
    if (t.id === 'terminal' || t.id === 'scripts') return !isServer
    return true
  })
  const tabs = openTabs.flatMap(id => available.filter(t => t.id === id))
  const activeTab = tabs.some(t => t.id === tab) ? tab : (tabs[0]?.id ?? null)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/20 px-1">
        <div
          role="tablist"
          aria-label="Right panel"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-hide"
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <div
              key={id}
              className={cn(
                'group/tab flex h-7 shrink-0 items-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                activeTab === id && 'bg-muted text-foreground'
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                data-testid={`right-panel-tab-${id}`}
                onClick={() => selectTab(id, worktreeId)}
                className="flex h-full items-center gap-1.5 pl-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Icon className="size-3.5" />
                {label}
              </button>
              <button
                type="button"
                aria-label={`Close ${label} tab`}
                onClick={() => useUIStore.getState().closeRightPanelTab(id)}
                className="ml-0.5 mr-1 flex size-4 items-center justify-center rounded opacity-60 hover:bg-accent-foreground/10 hover:opacity-100 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover/tab:opacity-60 focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Add tab"
                    data-testid="right-panel-add-tab"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Add tab</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="min-w-44">
              {available.map(({ id, label, icon: Icon, shortcut }) => (
                <DropdownMenuItem
                  key={id}
                  disabled={id !== 'files' && !canShowWorktreeTab}
                  onSelect={() => selectTab(id, worktreeId)}
                >
                  <Icon className="size-4" />
                  {label}
                  <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {worktreeId && worktreePath && (
          <OpenInButton
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            serverId={worktree?.serverId}
            branch={worktree?.branch}
            server={project?.server}
          />
        )}
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => useUIStore.getState().setFileBrowserVisible(false)}
            aria-label="Close right panel"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
        {activeTab === null && (
          <EmptyState>Add a tab with the + button.</EmptyState>
        )}
        {activeTab === 'files' && <FileBrowserSidebar />}
        {activeTab !== null && activeTab !== 'files' && !canShowWorktreeTab && (
          <EmptyState>Open a worktree to use this tab.</EmptyState>
        )}
        {activeTab === 'terminal' && worktreeId && worktreePath && (
          // data-terminal-root keeps Escape inside the terminal from closing
          // the session view.
          <div data-terminal-root="true" className="h-full">
            <TerminalView
              key={worktreeId}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
              isWorktreeActive
              hideControls
            />
          </div>
        )}
        {activeTab === 'browser' && worktreeId && worktreePath && (
          <div className="h-full pl-1">
            <BrowserView
              key={worktreeId}
              worktreeId={worktreeId}
              isVisible
              relayoutNonce={panelWidth}
            />
          </div>
        )}
        {activeTab === 'scripts' && worktreeId && worktreePath && (
          <ScriptsTab worktreeId={worktreeId} worktreePath={worktreePath} />
        )}
      </div>
    </div>
  )
}
