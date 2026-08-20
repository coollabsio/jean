import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  Check,
  ChevronDown,
  CircleDot,
  Bug,
  GitBranch,
  GitPullRequest,
  Link2,
  ListChecks,
  Bot,
  Paperclip,
  Shield,
  Settings,
  Star,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { ChatInput } from '@/components/chat/ChatInput'
import { useDragAndDropImages } from '@/components/chat/hooks/useDragAndDropImages'
import { ImagePreview } from '@/components/chat/ImagePreview'
import { SkillBadge } from '@/components/chat/SkillBadge'
import { TextFilePreview } from '@/components/chat/TextFilePreview'
import { DesktopBackendModelPicker } from '@/components/chat/toolbar/DesktopBackendModelPicker'
import { MobileBackendModelPickerSheet } from '@/components/chat/toolbar/MobileBackendModelPickerSheet'
import { ExecutionModeDropdown } from '@/components/chat/toolbar/ExecutionModeDropdown'
import { BackendLabel } from '@/components/ui/backend-label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useIsMobile } from '@/hooks/use-mobile'
import { invoke, listen } from '@/lib/transport'
import { generateId } from '@/lib/uuid'
import { resolveDefaultModelForBackend } from '@/lib/session-defaults'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import type { ExecutionMode, QueuedMessage } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import type { Project, Worktree } from '@/types/projects'
import {
  handleNextWorktreeErrorLocally,
  useProjectRemotes,
  type ProjectRemote,
} from '@/services/projects'
import { isInvalidWorktreeName } from './worktree-name-validation'
import {
  sourceContextOwnsBranch,
  getNewSessionSubmitLabel,
  getNewSessionContextDescription,
  type NewSessionSource,
  type NewSessionSourceContext,
  type NewSessionTabId,
} from './new-session-draft'
import {
  finishNewSessionFlow,
  prepareWorktreeCreationTracker,
  resolveWorktreeCreateArgs,
  startNewSessionPrompt,
  type WorktreeCreateArgs,
} from './new-session-flow'

export function getNewWorktreeDraftId(projectId: string | null): string {
  return `__new-worktree-draft__:${projectId ?? 'unknown'}`
}

export interface NewSessionComposerSettings {
  backend: CliBackend
  model: string
  executionMode: ExecutionMode
  baseBranch: string
  customName: string
}
const sources: {
  tab: NewSessionTabId
  label: string
  description: string
  icon: LucideIcon
}[] = [
  {
    tab: 'issues',
    label: 'GitHub issue',
    description: 'Start with the issue and its discussion',
    icon: CircleDot,
  },
  {
    tab: 'prs',
    label: 'Pull request',
    description: 'Check out or stack on an existing PR',
    icon: GitPullRequest,
  },
  {
    tab: 'security',
    label: 'Security alert',
    description: 'Fix an alert or repository advisory',
    icon: Shield,
  },
  {
    tab: 'branches',
    label: 'Existing branch',
    description: 'Continue work from a local branch',
    icon: GitBranch,
  },
  {
    tab: 'linear',
    label: 'Linear issue',
    description: 'Start with a Linear task and its context',
    icon: ListChecks,
  },
  {
    tab: 'pipeline',
    label: 'AI pipeline',
    description: 'Generate and orchestrate a multi-agent plan',
    icon: Bot,
  },
  {
    tab: 'sentry',
    label: 'Sentry issue',
    description: 'Investigate an error with its stack trace',
    icon: Bug,
  },
]

export function NewSessionComposer({
  projectId,
  projectName,
  projects,
  onSelectProject,
  projectPath,
  defaultBranch,
  remotes,
  branches,
  isLoadingBranches,
  setupScript,
  onSelectBase,
  hasBaseSession,
  showConfigureProject,
  onConfigureProject,
  source,
  sourceContext,
  onClearSourceContext,
  onCreated,
  onCompleted,
  onRetry,
  onConfigureBackends,
  createWorktree,
  createWorktreeFromBranch,
  createBaseSession,
  initialSettings,
  onSettingsChange,
  onOpenTab,
}: {
  projectId: string | null
  projectName: string
  projects: Project[]
  onSelectProject: (projectId: string) => void
  projectPath?: string
  defaultBranch?: string
  remotes: ProjectRemote[]
  branches: string[]
  isLoadingBranches: boolean
  setupScript?: string | null
  onSelectBase: () => void
  hasBaseSession: boolean
  showConfigureProject: boolean
  onConfigureProject: () => void
  source: NewSessionSource | null
  sourceContext: NewSessionSourceContext | null
  onClearSourceContext: () => void
  onCreated: () => void
  onCompleted?: () => void
  onRetry?: () => void
  onConfigureBackends: () => void
  createWorktree: (args: WorktreeCreateArgs) => Promise<Worktree>
  createWorktreeFromBranch: (branchName: string) => Promise<Worktree>
  createBaseSession: () => Promise<Worktree>
  initialSettings?: NewSessionComposerSettings | null
  onSettingsChange?: (settings: NewSessionComposerSettings) => void
  onOpenTab: (tab: NewSessionTabId) => void
}) {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const { installedBackends, isLoading: areBackendsLoading } =
    useInstalledBackends()
  const isMobile = useIsMobile()
  const preferredBackend = preferences?.default_backend as
    | CliBackend
    | undefined
  const defaultBackend = (
    preferredBackend && installedBackends.includes(preferredBackend)
      ? preferredBackend
      : (installedBackends[0] ?? preferredBackend ?? 'claude')
  ) as CliBackend
  const [backend, setBackend] = useState<CliBackend>(
    initialSettings?.backend ?? defaultBackend
  )
  const [model, setModel] = useState(
    () =>
      initialSettings?.model ??
      resolveDefaultModelForBackend(defaultBackend, preferences)
  )
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(
    initialSettings?.executionMode ??
      preferences?.default_execution_mode ??
      'plan'
  )
  const [baseBranch, setBaseBranch] = useState(
    initialSettings?.baseBranch ?? defaultBranch ?? 'main'
  )
  const { data: remotesForBase } = useProjectRemotes(projectPath, baseBranch)
  const activeRemotes =
    remotesForBase && remotesForBase.length > 0 ? remotesForBase : remotes
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [namePickerOpen, setNamePickerOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [mobileModelPickerOpen, setMobileModelPickerOpen] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [customName, setCustomName] = useState(
    initialSettings?.customName ?? ''
  )
  const [selectedRemote, setSelectedRemote] = useState<string | null>(() =>
    activeRemotes.length > 1 ? (activeRemotes[0]?.name ?? null) : null
  )
  const [hasPrompt, setHasPrompt] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const previousProjectIdRef = useRef(projectId)
  const previousDefaultBranchRef = useRef(defaultBranch)
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const attachRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const projectChanged = previousProjectIdRef.current !== projectId
    const defaultBranchChanged =
      previousDefaultBranchRef.current !== defaultBranch
    previousProjectIdRef.current = projectId
    previousDefaultBranchRef.current = defaultBranch
    if (projectChanged || defaultBranchChanged) {
      setBaseBranch(defaultBranch ?? 'main')
    }
    if (projectChanged) {
      setCustomName('')
      setSelectedRemote(
        activeRemotes.length > 1 ? (activeRemotes[0]?.name ?? null) : null
      )
    }
  }, [activeRemotes, defaultBranch, projectId])

  useEffect(() => {
    if (activeRemotes.length <= 1) {
      setSelectedRemote(null)
      return
    }
    if (
      !selectedRemote ||
      !activeRemotes.some(remote => remote.name === selectedRemote)
    ) {
      setSelectedRemote(activeRemotes[0]?.name ?? null)
    }
  }, [activeRemotes, selectedRemote])

  const handleBackendModelChange = (
    nextBackend: CliBackend,
    nextModel: string
  ) => {
    setBackend(nextBackend)
    setModel(nextModel)
  }
  const favoritePrefix = projectId ? `${projectId}:` : null
  const favoriteBranchKeys = preferences?.favorite_base_branches ?? []
  const favoriteBranches = useMemo(
    () =>
      new Set(
        favoritePrefix
          ? favoriteBranchKeys.flatMap(key =>
              key.startsWith(favoritePrefix)
                ? [key.slice(favoritePrefix.length)]
                : []
            )
          : []
      ),
    [favoriteBranchKeys, favoritePrefix]
  )
  const branchOptions = useMemo(() => {
    const options = Array.from(
      new Set([defaultBranch, ...branches].filter(Boolean))
    ) as string[]
    return options.sort((a, b) => {
      const favoriteOrder =
        Number(favoriteBranches.has(b)) - Number(favoriteBranches.has(a))
      return favoriteOrder || a.localeCompare(b)
    })
  }, [branches, defaultBranch, favoriteBranches])
  const hasSetupScript = Boolean(setupScript)
  const sourceOwnsBranch = sourceContextOwnsBranch(source)
  const draftSessionId = getNewWorktreeDraftId(projectId)
  useDragAndDropImages(draftSessionId)
  const pendingImagesBySession = useChatStore(state => state.pendingImages)
  const pendingTextFilesBySession = useChatStore(
    state => state.pendingTextFiles
  )
  const pendingSkillsBySession = useChatStore(state => state.pendingSkills)
  const pendingImages = pendingImagesBySession[draftSessionId] ?? []
  const pendingTextFiles =
    pendingTextFilesBySession[draftSessionId] ?? []
  const pendingSkills = pendingSkillsBySession[draftSessionId] ?? []
  const hasPendingAttachments = useChatStore(state =>
    [
      state.pendingImages[draftSessionId],
      state.pendingFiles[draftSessionId],
      state.pendingSkills[draftSessionId],
      state.pendingTextFiles[draftSessionId],
    ].some(attachments => (attachments?.length ?? 0) > 0)
  )
  const hasConversationContent = hasPrompt || hasPendingAttachments
  const backendAvailable = installedBackends.includes(backend)
  const submitLabel = getNewSessionSubmitLabel(source)
  const contextDescription = getNewSessionContextDescription(source)
  const hasInvalidName = isInvalidWorktreeName(customName)
  const hasWorktreeOptions =
    source?.type !== 'branch' && source?.type !== 'base'
  const visibleProjects = useMemo(() => {
    const query = projectSearch.trim().toLocaleLowerCase()
    return query
      ? projects.filter(project =>
          project.name.toLocaleLowerCase().includes(query)
        )
      : projects
  }, [projectSearch, projects])
  const defaultStartPoint = selectedRemote
    ? `${selectedRemote}/${baseBranch}`
    : baseBranch

  useEffect(() => {
    onSettingsChange?.({
      backend,
      model,
      executionMode,
      baseBranch,
      customName,
    })
  }, [backend, model, executionMode, baseBranch, customName, onSettingsChange])

  useEffect(() => {
    if (
      areBackendsLoading ||
      installedBackends.length === 0 ||
      installedBackends.includes(backend)
    ) {
      return
    }
    const fallback = installedBackends.at(0)
    if (!fallback) return
    setBackend(fallback)
    setModel(resolveDefaultModelForBackend(fallback, preferences))
  }, [areBackendsLoading, backend, installedBackends, preferences])

  const handleCreate = async () => {
    const message = inputRef.current?.value.trim() ?? ''
    const store = useChatStore.getState()
    const messageAttachments = {
      pendingImages: store.getPendingImages(draftSessionId),
      pendingFiles: store.getPendingFiles(draftSessionId),
      pendingSkills: store.getPendingSkills(draftSessionId),
      pendingTextFiles: store.getPendingTextFiles(draftSessionId),
    }
    const hasAttachments = Object.values(messageAttachments).some(
      attachments => attachments.length > 0
    )
    if (
      !projectId ||
      isCreating ||
      hasInvalidName ||
      ((message || hasAttachments) &&
        (areBackendsLoading || !backendAvailable))
    )
      return
    setIsCreating(true)
    const shouldCreateMore = createMore
    const toastId = toast.loading('Creating worktree…')
    let dispatched = false
    let tracker: Awaited<
      ReturnType<typeof prepareWorktreeCreationTracker>
    > | null = null
    let queuedMessage: QueuedMessage | undefined
    let pendingWorktreeId: string | null = null
    try {
      const createArgs = await resolveWorktreeCreateArgs(invoke, {
        projectId,
        projectPath,
        source,
        baseBranch: sourceOwnsBranch ? undefined : defaultStartPoint,
        customName: customName.trim(),
      })
      queuedMessage = message || hasAttachments
        ? {
            id: generateId(),
            message,
            ...messageAttachments,
            model,
            provider: null,
            executionMode,
            thinkingLevel: store.getThinkingLevel(draftSessionId),
            backend,
            queuedAt: Date.now(),
          }
        : undefined
      if (source?.type !== 'base') {
        tracker = await prepareWorktreeCreationTracker(listen)
      }
      const pendingWorktree =
        source?.type === 'base'
          ? await createBaseSession()
          : source?.type === 'branch'
            ? await createWorktreeFromBranch(source.branch)
            : await createWorktree(createArgs)
      pendingWorktreeId = pendingWorktree.id
      if (source?.type !== 'base') {
        handleNextWorktreeErrorLocally(pendingWorktree.id)
      }

      if (queuedMessage) {
        store.setPendingSetupMessage(pendingWorktree.id, queuedMessage)
      }

      dispatched = true
      store.clearInputDraft(draftSessionId)
      store.clearPendingImages(draftSessionId)
      store.clearPendingFiles(draftSessionId)
      store.clearPendingSkills(draftSessionId)
      store.clearPendingTextFiles(draftSessionId)
      if (inputRef.current) inputRef.current.value = ''
      setHasPrompt(false)
      if (shouldCreateMore) setIsCreating(false)
      if (!shouldCreateMore) onCreated()
      if (shouldCreateMore) {
        toast.loading(
          source?.type === 'base'
            ? 'Opening project session…'
            : 'Preparing worktree and project setup…',
          { id: toastId }
        )
      } else {
        toast.dismiss(toastId)
      }

      const creationTracker = tracker
      const waitForWorktree =
        source?.type === 'base'
          ? async () => pendingWorktree
          : creationTracker
            ? (id: string) => creationTracker.waitForCreated(id)
            : null
      if (!waitForWorktree) throw new Error('Creation tracker is unavailable')
      const waitForSetup =
        source?.type !== 'base' && hasSetupScript && creationTracker
          ? (id: string) => creationTracker.waitForSetup(id)
          : undefined

      const result = await finishNewSessionFlow({
        pendingWorktree,
        waitForWorktree,
        waitForSetup,
        invoke,
        queuedMessage,
        createFreshSession: source?.type === 'base',
      })

      store.registerWorktreePath(result.worktree.id, result.worktree.path)
      store.addUserInitiatedSession(result.session.id)
      if (queuedMessage) {
        store.setSelectedBackend(result.session.id, backend)
        store.setSelectedModel(result.session.id, model)
        store.setExecutionMode(result.session.id, executionMode)
        store.setLastSentMessage(result.session.id, queuedMessage.message)
        store.addSendingSession(result.session.id)
        void startNewSessionPrompt(
          invoke,
          result.worktree,
          result.session,
          queuedMessage
        )
          .catch(error => {
            store.removeSendingSession(result.session.id)
            toast.error(
              'Worktree created, but the prompt could not be started',
              { description: String(error) }
            )
          })
          .finally(() => {
            store.clearPendingSetupPrompt(result.worktree.id)
          })
      }
      if (shouldCreateMore) {
        toast.success(
          queuedMessage
            ? 'Session created — prompt started'
            : 'Worktree created',
          { id: toastId }
        )
      } else {
        store.setActiveSession(result.worktree.id, result.session.id)
        const projects = useProjectsStore.getState()
        projects.expandProject(projectId)
        projects.selectWorktree(result.worktree.id)
        window.dispatchEvent(
          new CustomEvent('open-worktree-modal', {
            detail: {
              worktreeId: result.worktree.id,
              worktreePath: result.worktree.path,
            },
          })
        )
        onCompleted?.()
        toast.success(
          queuedMessage
            ? 'Session created — prompt started'
            : 'Worktree created',
          { id: toastId }
        )
      }
    } catch (error) {
      // The modal may have closed after dispatch and be reopened through the
      // retry action. Never leave that restored composer locked in "Creating".
      setIsCreating(false)
      if (pendingWorktreeId) store.clearPendingSetupPrompt(pendingWorktreeId)
      if (
        dispatched &&
        queuedMessage &&
        !(inputRef.current?.value.trim() ?? '')
      ) {
        store.setInputDraft(draftSessionId, queuedMessage.message)
        if (inputRef.current) inputRef.current.value = queuedMessage.message
        setHasPrompt(true)
        queuedMessage.pendingImages.forEach(image =>
          store.addPendingImage(draftSessionId, image)
        )
        queuedMessage.pendingFiles.forEach(file =>
          store.addPendingFile(draftSessionId, file)
        )
        queuedMessage.pendingSkills.forEach(skill =>
          store.addPendingSkill(draftSessionId, skill)
        )
        queuedMessage.pendingTextFiles.forEach(textFile =>
          store.addPendingTextFile(draftSessionId, textFile)
        )
      }
      if (dispatched && onRetry && !shouldCreateMore) {
        onRetry()
      }
      toast.error('Failed to create session', {
        id: toastId,
        description: String(error),
        duration: 10_000,
      })
    } finally {
      tracker?.dispose()
      if (!dispatched || shouldCreateMore) setIsCreating(false)
    }
  }

  return (
    <form
      ref={formRef}
      className="flex min-h-0 flex-1 flex-col bg-card"
      onSubmit={event => {
        event.preventDefault()
        void handleCreate()
      }}
    >
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
        <DropdownMenu
          onOpenChange={open => {
            if (!open) setProjectSearch('')
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Choose project"
              className="flex h-8 min-w-0 max-w-64 flex-1 items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted"
            >
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground"
              >
                {projectName.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate text-sm font-medium">
                {projectName}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Project</DropdownMenuLabel>
            <div className="px-1 pb-1">
              <Input
                value={projectSearch}
                onChange={event => setProjectSearch(event.target.value)}
                onKeyDown={event => event.stopPropagation()}
                placeholder="Search projects…"
                aria-label="Search projects"
                className="h-8 text-xs"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {visibleProjects.map(project => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => onSelectProject(project.id)}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground"
                  >
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate">{project.name}</span>
                  {project.id === projectId && (
                    <Check className="ml-auto h-4 w-4" />
                  )}
                </DropdownMenuItem>
              ))}
              {visibleProjects.length === 0 && (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No project found.
                </p>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Choose starting point"
              title={contextDescription ?? undefined}
              className="ml-auto flex h-8 max-w-56 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Link2 className="h-3.5 w-3.5" />
              <span className="truncate">
                {sourceContext
                  ? sourceContext.kind
                  : `New worktree from ${defaultStartPoint}`}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Create from</DropdownMenuLabel>
            {(activeRemotes.length > 1 ? activeRemotes : [null]).map(remote => {
              const startPoint = remote
                ? `${remote.name}/${baseBranch}`
                : baseBranch
              const isSelected =
                !source && selectedRemote === (remote?.name ?? null)
              return (
                <DropdownMenuItem
                  key={remote?.name ?? 'default'}
                  onSelect={() => {
                    setSelectedRemote(remote?.name ?? null)
                    onClearSourceContext()
                  }}
                  className="items-start py-2"
                >
                  <GitBranch className="mt-0.5 h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      New worktree from {startPoint}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {remote?.repo
                        ? `Create from ${remote.repo}`
                        : remote
                          ? `Create from the ${remote.name} remote`
                          : 'Create an isolated branch with an automatic name'}
                    </span>
                  </span>
                  {isSelected && <Check className="mt-0.5 h-4 w-4" />}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            {sources.map(sourceOption => {
              const SourceIcon = sourceOption.icon
              return (
                <DropdownMenuItem
                  key={sourceOption.tab}
                  onSelect={() => onOpenTab(sourceOption.tab)}
                  className="items-start py-2"
                >
                  <SourceIcon className="mt-0.5 h-4 w-4" />
                  <span className="min-w-0">
                    <span className="block">{sourceOption.label}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {sourceOption.description}
                    </span>
                  </span>
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            {hasWorktreeOptions && (
              <DropdownMenuItem onSelect={() => setOptionsOpen(open => !open)}>
                <GitBranch className="h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block">Worktree options</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {sourceOwnsBranch
                      ? 'Source branch selected'
                      : `Base ${baseBranch}`}
                    {customName ? ` · ${customName}` : ' · Automatic name'}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={onSelectBase}
              className="items-start text-amber-700 focus:text-amber-700 dark:text-amber-300 dark:focus:text-amber-300"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4" />
              <span>
                Project folder
                <span className="block text-[10px] opacity-80">
                  {hasBaseSession
                    ? 'Open the existing project session'
                    : 'Create a session without worktree isolation'}
                </span>
              </span>
            </DropdownMenuItem>
            {showConfigureProject && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onConfigureProject}>
                  <Settings className="h-4 w-4" />
                  Configure project setup
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {sourceContext && (
          <button
            type="button"
            onClick={onClearSourceContext}
            aria-label="Remove source context"
            className="-ml-2 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div
        className="min-h-[144px] flex-1 cursor-text px-4 py-3"
        onClick={() => inputRef.current?.focus()}
      >
        <ImagePreview
          images={pendingImages}
          onRemove={imageId =>
            useChatStore.getState().removePendingImage(draftSessionId, imageId)
          }
          disabled={isCreating}
        />
        <TextFilePreview
          textFiles={pendingTextFiles}
          onRemove={textFileId =>
            useChatStore
              .getState()
              .removePendingTextFile(draftSessionId, textFileId)
          }
          sessionId={draftSessionId}
          disabled={isCreating}
        />
        {pendingSkills.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 py-2 md:px-6">
            {pendingSkills.map(skill => (
              <SkillBadge
                key={skill.id}
                skill={skill}
                onRemove={
                  isCreating
                    ? undefined
                    : () =>
                        useChatStore
                          .getState()
                          .removePendingSkill(draftSessionId, skill.id)
                }
              />
            ))}
          </div>
        )}
        <ChatInput
          activeSessionId={draftSessionId}
          activeWorktreePath={projectPath}
          activeProjectId={projectId}
          isSending={false}
          executionMode={executionMode}
          canSwitchBackendWithTab
          focusChatShortcut=""
          showFocusHint={false}
          clearOnSubmit={false}
          onSubmit={event => {
            event.preventDefault()
            void handleCreate()
          }}
          onCancel={() => undefined}
          formRef={formRef}
          inputRef={inputRef}
          installedBackends={installedBackends}
          selectedBackend={backend}
          onRegisterAttachHandler={handler => {
            attachRef.current = handler
          }}
          onHasValueChange={setHasPrompt}
        />
      </div>

      {optionsOpen && hasWorktreeOptions && (
        <div
          className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-muted/35 px-2 py-2"
          data-testid="worktree-options"
        >
          {!sourceOwnsBranch && (
            <Popover open={branchPickerOpen} onOpenChange={setBranchPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`Base branch: ${baseBranch}`}
                  className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  <span className="font-mono">{baseBranch}</span>
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-0">
                <Command>
                  <CommandInput placeholder="Search base branches…" />
                  <CommandList>
                    <CommandEmpty>
                      {isLoadingBranches
                        ? 'Loading branches…'
                        : 'No branch found.'}
                    </CommandEmpty>
                    {branchOptions.map(branch => (
                      <CommandItem
                        key={branch}
                        value={branch}
                        onSelect={() => {
                          setBaseBranch(branch)
                          setBranchPickerOpen(false)
                        }}
                      >
                        <Check
                          className={`mr-2 h-3.5 w-3.5 ${baseBranch === branch ? 'opacity-100' : 'opacity-0'}`}
                        />
                        <span className="truncate font-mono text-xs">
                          {branch}
                        </span>
                        {projectId && (
                          <button
                            type="button"
                            aria-label={
                              favoriteBranches.has(branch)
                                ? `Unstar ${branch}`
                                : `Star ${branch}`
                            }
                            aria-pressed={favoriteBranches.has(branch)}
                            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            onPointerDown={event => {
                              event.preventDefault()
                              event.stopPropagation()
                            }}
                            onClick={event => {
                              event.preventDefault()
                              event.stopPropagation()
                              const key = `${projectId}:${branch}`
                              patchPreferences.mutate({
                                favorite_base_branches:
                                  favoriteBranchKeys.includes(key)
                                    ? favoriteBranchKeys.filter(
                                        favorite => favorite !== key
                                      )
                                    : [...favoriteBranchKeys, key],
                              })
                            }}
                          >
                            <Star
                              className={cn(
                                'h-3.5 w-3.5',
                                favoriteBranches.has(branch) &&
                                  'fill-yellow-500 text-yellow-500'
                              )}
                            />
                          </button>
                        )}
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
          <Popover open={namePickerOpen} onOpenChange={setNamePickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Worktree name: ${customName || 'Automatic'}`}
                className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <span>Name</span>
                <span className="font-mono text-foreground">
                  {customName || 'Automatic'}
                </span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-2 p-3">
              <div>
                <p className="text-xs font-medium">Worktree name</p>
                <p className="text-[11px] text-muted-foreground">
                  Leave empty to let Jean generate it.
                </p>
              </div>
              <Input
                value={customName}
                onChange={event => setCustomName(event.target.value)}
                placeholder="Automatic"
                aria-invalid={hasInvalidName}
                className="h-8 text-xs"
              />
              {hasInvalidName && (
                <p className="text-[11px] text-destructive">
                  Invalid worktree name
                </p>
              )}
            </PopoverContent>
          </Popover>
        </div>
      )}

      <div className="@container flex flex-col gap-1 px-4 pt-1 pb-3.5 md:flex-row md:items-center">
        <div className="flex min-w-0 items-center gap-1">
          {!areBackendsLoading && installedBackends.length === 0 ? (
            <button
              type="button"
              onClick={onConfigureBackends}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
            >
              Configure agents
            </button>
          ) : isMobile ? (
            <>
              <button
                type="button"
                aria-label="Choose backend and model"
                onClick={() => setMobileModelPickerOpen(true)}
                className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <BackendLabel backend={backend} className="shrink-0" />
                <span className="truncate">· {model}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
              </button>
              <MobileBackendModelPickerSheet
                open={mobileModelPickerOpen}
                onOpenChange={setMobileModelPickerOpen}
                selectedBackend={backend}
                selectedProvider={null}
                selectedModel={model}
                installedBackends={installedBackends}
                customCliProfiles={preferences?.custom_cli_profiles ?? []}
                onModelChange={setModel}
                onBackendModelChange={handleBackendModelChange}
              />
            </>
          ) : (
            <DesktopBackendModelPicker
              selectedBackend={backend}
              selectedModel={model}
              selectedProvider={null}
              installedBackends={installedBackends}
              customCliProfiles={preferences?.custom_cli_profiles ?? []}
              onModelChange={setModel}
              onBackendModelChange={handleBackendModelChange}
              triggerClassName="border-0 bg-transparent shadow-none"
            />
          )}
          <ExecutionModeDropdown
            executionMode={executionMode}
            onSetExecutionMode={setExecutionMode}
          />
          <button
            type="button"
            aria-label="Attach files"
            onClick={() => attachRef.current?.()}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Paperclip className="h-4 w-4" />
          </button>
        </div>
        <div className="flex w-full items-center justify-end gap-1 md:ml-auto md:w-auto">
          <label className="mr-auto flex cursor-pointer items-center gap-2 px-2 text-xs text-muted-foreground md:mr-0">
            <Switch
              checked={createMore}
              onCheckedChange={setCreateMore}
              aria-label="Create more"
              disabled={isCreating}
            />
            <span>Create more</span>
          </label>
          <button
            type="submit"
            disabled={
              !projectId ||
              isCreating ||
              hasInvalidName ||
              (hasConversationContent &&
                (areBackendsLoading || !backendAvailable))
            }
            className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:shadow-none disabled:opacity-35"
          >
            {isCreating
              ? 'Creating…'
              : areBackendsLoading
                ? 'Checking backends…'
                : hasConversationContent && !backendAvailable
                  ? 'No backend available'
                  : hasConversationContent
                    ? submitLabel
                    : submitLabel.replace(' & start', '')}{' '}
            {!isCreating && !isMobile && (
              <span className="ml-1 opacity-60">↵</span>
            )}
          </button>
        </div>
      </div>
    </form>
  )
}
