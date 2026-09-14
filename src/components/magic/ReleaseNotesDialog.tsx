import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, FileText, Loader2, RefreshCw, Tag, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { isGhAuthError } from '@/services/github'
import { useGhLogin } from '@/hooks/useGhLogin'
import { GhAuthError } from '@/components/shared/GhAuthError'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import {
  useCreateBaseSession,
  useProjects,
  useWorktrees,
} from '@/services/projects'
import { useCreateSession, useSendMessage } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import { usePreferences } from '@/services/preferences'
import { resolveMcpConfigForSend } from '@/services/mcp'
import { buildReleaseNotesFromTagSessionPrompt } from '@/lib/release-notes-prompt'
import { isBaseSession, type GitHubRelease } from '@/types/projects'
import {
  resolveMagicPromptBackend,
  resolveMagicPromptProvider,
  type CliBackend,
} from '@/types/preferences'

export function ReleaseNotesDialog() {
  const { triggerLogin, isGhInstalled } = useGhLogin()
  const { releaseNotesModalOpen, setReleaseNotesModalOpen } = useUIStore()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: projects } = useProjects()
  const { data: worktrees } = useWorktrees(selectedProjectId)
  const { data: preferences } = usePreferences()
  const createBaseSession = useCreateBaseSession()
  const createSession = useCreateSession()
  const sendMessage = useSendMessage()

  const project = useMemo(
    () => projects?.find(item => item.id === selectedProjectId),
    [projects, selectedProjectId]
  )
  const [releases, setReleases] = useState<GitHubRelease[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLaunching, setIsLaunching] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const fetchReleases = useCallback(async () => {
    if (!project?.path) return
    setIsLoading(true)
    setError(null)
    try {
      setReleases(
        await invoke<GitHubRelease[]>('list_github_releases', {
          projectPath: project.path,
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setIsLoading(false)
    }
  }, [project?.path])

  useEffect(() => {
    if (releaseNotesModalOpen) void fetchReleases()
  }, [releaseNotesModalOpen, fetchReleases])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setReleases([])
        setSelectedIndex(0)
        setIsLaunching(false)
        setError(null)
      }
      setReleaseNotesModalOpen(open)
    },
    [setReleaseNotesModalOpen]
  )

  const handleSelectRelease = useCallback(
    async (release: GitHubRelease) => {
      if (!selectedProjectId || !project) return
      setIsLaunching(true)

      try {
        const baseWorktree =
          worktrees?.find(isBaseSession) ??
          (await createBaseSession.mutateAsync(selectedProjectId))
        const prompt = buildReleaseNotesFromTagSessionPrompt(
          release.tagName,
          release.name || release.tagName,
          preferences?.magic_prompts?.release_notes
        )
        const session = await createSession.mutateAsync({
          worktreeId: baseWorktree.id,
          worktreePath: baseWorktree.path,
          name: `Release notes since ${release.tagName}`,
        })
        const store = useChatStore.getState()
        const defaultBackend =
          project.default_backend ?? preferences?.default_backend ?? 'claude'
        const backend = (resolveMagicPromptBackend(
          preferences?.magic_prompt_backends,
          'release_notes_backend',
          defaultBackend
        ) ?? defaultBackend) as CliBackend
        const model =
          preferences?.magic_prompt_models?.release_notes_model ?? undefined
        const provider = resolveMagicPromptProvider(
          preferences?.magic_prompt_providers,
          'release_notes_provider',
          preferences?.default_provider
        )

        store.registerWorktreePath(baseWorktree.id, baseWorktree.path)
        store.setSelectedBackend(session.id, backend)
        if (model) store.setSelectedModel(session.id, model)
        store.setSelectedProvider(session.id, provider)
        store.setActiveSession(baseWorktree.id, session.id)
        store.setExecutionMode(session.id, 'yolo')

        const { mcpConfig, enabledServers } = await resolveMcpConfigForSend({
          worktreePath: baseWorktree.path,
          backend,
          projectEnabled: project.enabled_mcp_servers,
          globalEnabled: preferences?.default_enabled_mcp_servers,
          knownServers:
            project.known_mcp_servers ?? preferences?.known_mcp_servers,
        })
        store.setEnabledMcpServers(session.id, enabledServers)

        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: {
              sessionId: session.id,
              worktreeId: baseWorktree.id,
              worktreePath: baseWorktree.path,
            },
          })
        )
        setReleaseNotesModalOpen(false)

        sendMessage.mutate({
          sessionId: session.id,
          worktreeId: baseWorktree.id,
          worktreePath: baseWorktree.path,
          message: prompt,
          executionMode: 'yolo',
          backend: backend !== 'claude' ? backend : undefined,
          model,
          customProfileName: provider ?? undefined,
          effortLevel:
            preferences?.magic_prompt_efforts?.release_notes_effort ?? undefined,
          mcpConfig,
          includeRecap: false,
        })
      } catch (cause) {
        toast.error(`Failed to start release notes session: ${cause}`)
        setIsLaunching(false)
      }
    },
    [
      selectedProjectId,
      project,
      worktrees,
      createBaseSession,
      createSession,
      sendMessage,
      preferences,
      setReleaseNotesModalOpen,
    ]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
      event.stopPropagation()
      if (isLaunching || releases.length === 0) return
      event.preventDefault()
      if (event.key === 'ArrowDown') {
        setSelectedIndex(index => Math.min(index + 1, releases.length - 1))
      } else if (event.key === 'ArrowUp') {
        setSelectedIndex(index => Math.max(index - 1, 0))
      } else if (releases[selectedIndex]) {
        void handleSelectRelease(releases[selectedIndex])
      }
    },
    [handleSelectRelease, isLaunching, releases, selectedIndex]
  )

  return (
    <Dialog open={releaseNotesModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="!max-w-lg h-[500px] p-0 flex flex-col"
        onKeyDown={handleKeyDown}
        showCloseButton={false}
      >
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            <span className="flex-1">
              Release Notes for {project?.name ?? 'Project'}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={fetchReleases}
                  disabled={isLoading || isLaunching}
                  aria-label="Refresh releases"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md opacity-70 hover:bg-accent hover:opacity-100"
                >
                  <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Refresh releases</TooltipContent>
            </Tooltip>
            <DialogClose className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
              <XIcon className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1">
          {(isLoading || isLaunching) && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {isLaunching ? 'Opening release notes session...' : 'Loading releases...'}
              </span>
            </div>
          )}
          {error &&
            (isGhAuthError(error) ? (
              <GhAuthError onLogin={triggerLogin} isGhInstalled={isGhInstalled} />
            ) : (
              <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                <AlertCircle className="h-5 w-5 text-destructive" />
                {error.message || 'Failed to load releases'}
              </div>
            ))}
          {!isLoading && !isLaunching && !error && releases.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
              <Tag className="mb-2 h-5 w-5" />
              No releases found
            </div>
          )}
          {!isLoading && !isLaunching && !error && releases.length > 0 && (
            <div className="py-1">
              <div className="px-4 py-1 text-xs text-muted-foreground">
                Select a release. Jean will open a session and generate copyable Markdown notes for changes since that version.
              </div>
              {releases.map((release, index) => (
                <ReleaseItem
                  key={release.tagName}
                  release={release}
                  isSelected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => void handleSelectRelease(release)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function ReleaseItem({
  release,
  isSelected,
  onMouseEnter,
  onClick,
}: {
  release: GitHubRelease
  isSelected: boolean
  onMouseEnter: () => void
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent focus:outline-none',
        isSelected && 'bg-accent'
      )}
    >
      <Tag className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {release.name || release.tagName}
          </span>
          {release.isLatest && (
            <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-600">
              Latest
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {release.tagName}
        </span>
      </div>
    </button>
  )
}

export default ReleaseNotesDialog
