import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@/lib/transport'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Tag,
  XIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { openExternal } from '@/lib/platform'
import { copyToClipboard } from '@/lib/clipboard'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useProjects } from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { resolveMagicPromptProvider } from '@/types/preferences'
import type { GitHubRelease, ReleaseNotesResponse } from '@/types/projects'

type Phase = 'select' | 'generate' | 'result'

export function ReleaseNotesDialog() {
  const { triggerLogin: triggerGhLogin, isGhInstalled } = useGhLogin()
  const { releaseNotesModalOpen, setReleaseNotesModalOpen } = useUIStore()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: preferences } = usePreferences()

  // Get project data
  const { data: projects } = useProjects()
  const selectedProject = useMemo(
    () => projects?.find(p => p.id === selectedProjectId),
    [projects, selectedProjectId]
  )

  // Local state
  const [phase, setPhase] = useState<Phase>('select')
  const [releases, setReleases] = useState<GitHubRelease[]>([])
  const [isLoadingReleases, setIsLoadingReleases] = useState(false)
  const [releasesError, setReleasesError] = useState<Error | null>(null)
  const [selectedItemIndex, setSelectedItemIndex] = useState(0)
  const [selectedRelease, setSelectedRelease] = useState<GitHubRelease | null>(
    null
  )
  const [generatedTitle, setGeneratedTitle] = useState('')
  const [generatedBody, setGeneratedBody] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [repoUrl, setRepoUrl] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  // Fetch releases and repo URL
  const fetchReleases = useCallback(async () => {
    if (!selectedProject?.path) return

    setIsLoadingReleases(true)
    setReleasesError(null)

    try {
      const [result, url] = await Promise.all([
        invoke<GitHubRelease[]>('list_github_releases', {
          projectPath: selectedProject.path,
        }),
        invoke<string>('get_github_repo_url', {
          repoPath: selectedProject.path,
        }).catch(() => null),
      ])
      setReleases(result)
      setRepoUrl(url)
    } catch (error) {
      setReleasesError(
        error instanceof Error ? error : new Error(String(error))
      )
    } finally {
      setIsLoadingReleases(false)
    }
  }, [selectedProject?.path])

  // Fetch releases when modal opens
  useEffect(() => {
    if (releaseNotesModalOpen && selectedProject?.path) {
      fetchReleases()
    }
  }, [releaseNotesModalOpen, selectedProject?.path, fetchReleases])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        // Reset state when closing
        setPhase('select')
        setReleases([])
        setSelectedItemIndex(0)
        setSelectedRelease(null)
        setGeneratedTitle('')
        setGeneratedBody('')
        setIsGenerating(false)
        setCopied(false)
        setRepoUrl(null)
      }
      setReleaseNotesModalOpen(open)
    },
    [setReleaseNotesModalOpen]
  )

  const handleSelectRelease = useCallback(
    async (release: GitHubRelease) => {
      if (!selectedProject?.path) return

      setSelectedRelease(release)
      setPhase('generate')
      setIsGenerating(true)

      try {
        const result = await invoke<ReleaseNotesResponse>(
          'generate_release_notes',
          {
            projectPath: selectedProject.path,
            tag: release.tagName,
            releaseName: release.name || release.tagName,
            customPrompt: preferences?.magic_prompts?.release_notes,
            model: preferences?.magic_prompt_models?.release_notes_model,
            customProfileName: resolveMagicPromptProvider(
              preferences?.magic_prompt_providers,
              'release_notes_provider',
              preferences?.default_provider
            ),
            reasoningEffort:
              preferences?.magic_prompt_efforts?.release_notes_effort ?? null,
          }
        )
        setGeneratedTitle(result.title)
        setGeneratedBody(result.body)
        setPhase('result')
      } catch (error) {
        toast.error(`Failed to generate release notes: ${error}`)
        setPhase('select')
      } finally {
        setIsGenerating(false)
      }
    },
    [selectedProject?.path, preferences]
  )

  const handleRegenerate = useCallback(() => {
    if (selectedRelease) {
      handleSelectRelease(selectedRelease)
    }
  }, [selectedRelease, handleSelectRelease])

  const handleBack = useCallback(() => {
    setPhase('select')
    setSelectedRelease(null)
    setGeneratedTitle('')
    setGeneratedBody('')
    setCopied(false)
  }, [])

  const handleCopy = useCallback(async () => {
    const text = `# ${generatedTitle}\n\n${generatedBody}`
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [generatedTitle, generatedBody])

  const handleCreateRelease = useCallback(async () => {
    if (!repoUrl) return
    const params = new URLSearchParams({
      title: generatedTitle,
      body: generatedBody,
    })
    await openExternal(`${repoUrl}/releases/new?${params.toString()}`)
  }, [repoUrl, generatedTitle, generatedBody])

  // Keyboard navigation for release list
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Always capture these keys to prevent them from reaching the chat/canvas behind this modal
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.stopPropagation()
      }

      if (phase !== 'select' || releases.length === 0) return

      const key = e.key.toLowerCase()

      if (key === 'arrowdown') {
        e.preventDefault()
        setSelectedItemIndex(prev => Math.min(prev + 1, releases.length - 1))
      } else if (key === 'arrowup') {
        e.preventDefault()
        setSelectedItemIndex(prev => Math.max(prev - 1, 0))
      } else if (key === 'enter' && releases[selectedItemIndex]) {
        e.preventDefault()
        handleSelectRelease(releases[selectedItemIndex])
      }
    },
    [phase, releases, selectedItemIndex, handleSelectRelease]
  )

  // Scroll selected item into view
  useEffect(() => {
    if (phase !== 'select') return
    const selectedElement = document.querySelector(
      `[data-release-item-index="${selectedItemIndex}"]`
    )
    selectedElement?.scrollIntoView({ block: 'nearest' })
  }, [selectedItemIndex, phase])

  return (
    <Dialog open={releaseNotesModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="!max-w-lg h-[500px] p-0 flex flex-col"
        onKeyDown={handleKeyDown}
        showCloseButton={false}
      >
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle className="flex items-center gap-2">
            {phase !== 'select' && (
              <button
                onClick={handleBack}
                className="p-0.5 rounded hover:bg-accent transition-colors"
                disabled={isGenerating}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <FileText className="h-4 w-4" />
            <span className="flex-1">
              {phase === 'select'
                ? `Release Notes for ${selectedProject?.name ?? 'Project'}`
                : phase === 'generate'
                  ? 'Generating...'
                  : 'Release Notes'}
            </span>
            {phase === 'select' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={fetchReleases}
                    disabled={isLoadingReleases}
                    className={cn(
                      'inline-flex h-7 w-7 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 hover:bg-accent',
                      'focus:ring-ring focus:ring-2 focus:ring-offset-2 focus:outline-hidden',
                      isLoadingReleases && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <RefreshCw
                      className={cn(
                        'size-4 text-muted-foreground',
                        isLoadingReleases && 'animate-spin'
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Refresh releases</TooltipContent>
              </Tooltip>
            )}
            <DialogClose className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50">
              <XIcon className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </DialogTitle>
        </DialogHeader>

        {/* Phase 1: Select Release */}
        {phase === 'select' && (
          <div className="flex flex-col flex-1 min-h-0">
            <ScrollArea className="flex-1" ref={scrollRef}>
              {isLoadingReleases && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    Loading releases...
                  </span>
                </div>
              )}

              {releasesError &&
                (isGhAuthError(releasesError) ? (
                  <GhAuthError
                    onLogin={triggerGhLogin}
                    isGhInstalled={isGhInstalled}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                    <AlertCircle className="h-5 w-5 text-destructive mb-2" />
                    <span className="text-sm text-muted-foreground">
                      {releasesError.message || 'Failed to load releases'}
                    </span>
                  </div>
                ))}

              {!isLoadingReleases &&
                !releasesError &&
                releases.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                    <Tag className="h-5 w-5 text-muted-foreground mb-2" />
                    <span className="text-sm text-muted-foreground">
                      No releases found
                    </span>
                    <span className="text-xs text-muted-foreground mt-1">
                      Create your first release on GitHub
                    </span>
                  </div>
                )}

              {!isLoadingReleases && !releasesError && releases.length > 0 && (
                <div className="py-1">
                  <div className="px-4 py-1 text-xs text-muted-foreground">
                    Select a release to compare changes since:
                  </div>
                  {releases.map((release, index) => (
                    <ReleaseItem
                      key={release.tagName}
                      release={release}
                      index={index}
                      isSelected={index === selectedItemIndex}
                      onMouseEnter={() => setSelectedItemIndex(index)}
                      onClick={() => handleSelectRelease(release)}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        )}

        {/* Phase 2: Generating */}
        {phase === 'generate' && (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Generating release notes since{' '}
                <span className="font-medium text-foreground">
                  {selectedRelease?.tagName}
                </span>
                ...
              </span>
            </div>
          </div>
        )}

        {/* Phase 3: Result */}
        {phase === 'result' && (
          <div className="flex flex-col flex-1 min-h-0 px-4 pb-4 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Title
              </label>
              <Input
                value={generatedTitle}
                onChange={e => setGeneratedTitle(e.target.value)}
                className="text-sm"
              />
            </div>

            <div className="flex-1 flex flex-col min-h-0">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Body
              </label>
              <Textarea
                value={generatedBody}
                onChange={e => setGeneratedBody(e.target.value)}
                className="flex-1 min-h-0 text-sm resize-none font-mono"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRegenerate}
                disabled={isGenerating}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5 mr-1.5',
                    isGenerating && 'animate-spin'
                  )}
                />
                Regenerate
              </Button>
              <div className="flex-1" />
              {repoUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCreateRelease}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  Create on GitHub
                </Button>
              )}
              <Button size="sm" onClick={handleCopy}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface ReleaseItemProps {
  release: GitHubRelease
  index: number
  isSelected: boolean
  onMouseEnter: () => void
  onClick: () => void
}

function ReleaseItem({
  release,
  index,
  isSelected,
  onMouseEnter,
  onClick,
}: ReleaseItemProps) {
  const displayName = release.name || release.tagName
  const date = release.publishedAt
    ? new Date(release.publishedAt).toLocaleDateString()
    : ''

  return (
    <button
      data-release-item-index={index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
        'hover:bg-accent focus:outline-none',
        isSelected && 'bg-accent'
      )}
    >
      <Tag className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{displayName}</span>
          {release.isLatest && (
            <span className="text-xs text-green-600 bg-green-500/10 px-1.5 py-0.5 rounded">
              Latest
            </span>
          )}
          {release.isDraft && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              Draft
            </span>
          )}
          {release.isPrerelease && (
            <span className="text-xs text-yellow-600 bg-yellow-500/10 px-1.5 py-0.5 rounded">
              Pre-release
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground font-mono">
            {release.tagName}
          </span>
          {date && (
            <span className="text-xs text-muted-foreground">{date}</span>
          )}
        </div>
      </div>
    </button>
  )
}

export default ReleaseNotesDialog
