import { useState, useCallback, useEffect, useMemo } from 'react'
import { isLocalBackend, isNativeApp } from '@/lib/environment'
import {
  Loader2,
  Globe,
  FolderOpen,
  AlertCircle,
} from '@/components/icons/reicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProjectsStore } from '@/store/projects-store'
import { useCloneProject } from '@/services/projects'
import { DirectoryBrowser } from '@/components/projects/DirectoryBrowser'
import { toast } from 'sonner'
import { ServerTargetSelect } from './ServerTargetSelect'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { parseServerResourceKey } from '@/lib/server-resource'
import { useActiveConnectionId } from '@/lib/remote-connections'
import {
  buildProjectDestination,
  getLastProjectDestination,
  rememberProjectDestination,
} from '@/lib/project-destination'
import { buildCloneUrl, type GitProvider } from '@/lib/git-provider'

/** Extract a repository name from a git URL (strips .git suffix) */
function extractRepoName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const lastSegment = trimmed.split('/').pop() ?? trimmed.split(':').pop() ?? ''
  return lastSegment.replace(/\.git$/, '')
}

export function CloneProjectModal() {
  const {
    cloneModalOpen,
    closeCloneModal,
    setAddProjectDialogOpen,
    addProjectParentFolderId,
    selectedProjectId,
  } = useProjectsStore()

  const cloneProject = useCloneProject()

  const [provider, setProvider] = useState<GitProvider>('github')
  const [url, setUrl] = useState('')
  const [destination, setDestination] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const parentServerId = addProjectParentFolderId
    ? parseServerResourceKey(addProjectParentFolderId)?.serverId
    : undefined
  const activeConnectionId = useActiveConnectionId()
  const selectedProjectServerId = selectedProjectId
    ? parseServerResourceKey(selectedProjectId)?.serverId
    : undefined
  const currentServerId =
    parentServerId ?? selectedProjectServerId ?? activeConnectionId
  const [targetServerId, setTargetServerId] = useState(
    currentServerId ?? LOCAL_SERVER_ID
  )
  const effectiveServerId = parentServerId ?? targetServerId
  const lastDestination = useMemo(
    () => getLastProjectDestination(effectiveServerId),
    [cloneModalOpen, effectiveServerId]
  )

  const repoName = useMemo(() => extractRepoName(url), [url])
  const cloneUrl = useMemo(() => buildCloneUrl(provider, url), [provider, url])

  useEffect(() => {
    setDestination(
      lastDestination && repoName
        ? buildProjectDestination(lastDestination, repoName)
        : ''
    )
  }, [effectiveServerId, lastDestination, repoName])

  // Reset state when modal closes
  useEffect(() => {
    if (cloneModalOpen) {
      setTargetServerId(currentServerId)
    } else {
      setProvider('github')
      setUrl('')
      setDestination('')
      setError(null)
      setBrowserOpen(false)
    }
  }, [cloneModalOpen, currentServerId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setError(null)
        closeCloneModal()
      }
    },
    [closeCloneModal]
  )

  const handleBrowse = useCallback(async () => {
    // Remote backends (and pure web) must browse the server filesystem via
    // DirectoryBrowser — the native OS picker only sees the local machine.
    if (!isLocalBackend() || effectiveServerId !== LOCAL_SERVER_ID) {
      setBrowserOpen(true)
      return
    }

    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selected = await save({
        title: 'Choose clone destination',
        defaultPath: destination || repoName || 'repo',
      })

      if (selected && typeof selected === 'string') {
        setDestination(selected)
        rememberProjectDestination(effectiveServerId, selected)
      }
    } catch (error) {
      // User cancelled
      if (error instanceof Error && error.message.includes('cancel')) return
    }
  }, [destination, effectiveServerId, repoName])

  const handleClone = useCallback(async () => {
    if (!cloneUrl) {
      setError('Please enter a repository.')
      return
    }
    if (!destination) {
      setError('Please choose a destination directory.')
      return
    }

    setError(null)

    // Close modals immediately, use toast for progress
    closeCloneModal()
    setAddProjectDialogOpen(false)

    const toastId = toast.loading(`Cloning ${repoName || 'repository'}...`)

    try {
      await cloneProject.mutateAsync({
        url: cloneUrl,
        path: destination,
        parentId: addProjectParentFolderId ?? undefined,
        serverId: isNativeApp() ? effectiveServerId : undefined,
      })
      toast.dismiss(toastId)
    } catch {
      // Error toast is handled by the mutation's onError
      toast.dismiss(toastId)
    }
  }, [
    cloneUrl,
    destination,
    repoName,
    cloneProject,
    addProjectParentFolderId,
    effectiveServerId,
    closeCloneModal,
    setAddProjectDialogOpen,
  ])

  return (
    <Dialog open={cloneModalOpen} onOpenChange={handleOpenChange}>
      <>
        <DialogContent className="min-w-0 overflow-hidden sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              Clone Repository
            </DialogTitle>
            <DialogDescription>
              Clone a remote git repository from a provider or custom URL.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-4 py-4">
            <ServerTargetSelect
              id="clone-target-server"
              value={effectiveServerId}
              onChange={setTargetServerId}
              disabled={cloneProject.isPending || parentServerId !== undefined}
            />
            <div className="space-y-1.5">
              <Label htmlFor="clone-provider" className="text-xs">
                Git provider
              </Label>
              <Select
                value={provider}
                onValueChange={value => setProvider(value as GitProvider)}
                disabled={cloneProject.isPending}
              >
                <SelectTrigger id="clone-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="gitlab">GitLab</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Repository input */}
            <div className="space-y-1.5">
              <Label htmlFor="clone-url" className="text-xs">
                {provider === 'custom' ? 'Repository URL' : 'Repository'}
              </Label>
              <Input
                id="clone-url"
                placeholder={
                  provider === 'custom'
                    ? 'https://example.com/user/repo.git'
                    : 'user/repository'
                }
                value={url}
                onChange={e => setUrl(e.target.value)}
                disabled={cloneProject.isPending}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && cloneUrl && destination) {
                    e.preventDefault()
                    handleClone()
                  }
                }}
              />
            </div>

            {/* Destination picker */}
            <div className="space-y-1.5">
              <Label className="text-xs">Destination</Label>
              <div className="flex min-w-0 gap-2">
                <Button
                  variant="outline"
                  className="min-w-0 flex-1 justify-start overflow-hidden"
                  onClick={handleBrowse}
                  disabled={cloneProject.isPending}
                  title={destination || undefined}
                >
                  <FolderOpen className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left text-sm">
                    {destination || 'Choose destination...'}
                  </span>
                </Button>
              </div>
              {destination && (
                <p
                  className="max-w-full truncate text-xs text-muted-foreground"
                  title={destination}
                >
                  {destination}
                </p>
              )}
            </div>

            {/* Error display */}
            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-destructive">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                <div className="text-sm">{error}</div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={cloneProject.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleClone}
              disabled={cloneProject.isPending || !cloneUrl || !destination}
            >
              {cloneProject.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Clone
            </Button>
          </DialogFooter>
        </DialogContent>

        <DirectoryBrowser
          open={browserOpen}
          onOpenChange={setBrowserOpen}
          onSelect={selected => {
            setDestination(selected)
            rememberProjectDestination(effectiveServerId, selected)
          }}
          mode="save"
          title="Choose clone destination"
          description="Choose a parent folder and enter the cloned repository name."
          defaultName={repoName || 'repo'}
          initialPath={lastDestination}
          serverId={isNativeApp() ? effectiveServerId : undefined}
        />
      </>
    </Dialog>
  )
}

export default CloneProjectModal
