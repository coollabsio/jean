import { useState, useCallback, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { isNativeApp } from '@/lib/environment'
import { Loader2, Globe, FolderOpen, AlertCircle } from 'lucide-react'
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
import { useProjectsStore } from '@/store/projects-store'
import { useCloneProject } from '@/services/projects'

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
  } = useProjectsStore()

  const cloneProject = useCloneProject()

  const [url, setUrl] = useState('')
  const [destination, setDestination] = useState('')
  const [error, setError] = useState<string | null>(null)

  const repoName = useMemo(() => extractRepoName(url), [url])

  // Reset state when modal closes
  useEffect(() => {
    if (!cloneModalOpen) {
      setUrl('')
      setDestination('')
      setError(null)
    }
  }, [cloneModalOpen])

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
    if (!isNativeApp()) return

    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selected = await save({
        title: 'Choose clone destination',
        defaultPath: repoName || 'repo',
      })

      if (selected && typeof selected === 'string') {
        setDestination(selected)
      }
    } catch (error) {
      // User cancelled
      if (error instanceof Error && error.message.includes('cancel')) return
    }
  }, [repoName])

  const handleClone = useCallback(async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      setError('Please enter a git URL.')
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
        url: trimmedUrl,
        path: destination,
        parentId: addProjectParentFolderId ?? undefined,
      })
      toast.dismiss(toastId)
    } catch {
      // Error toast is handled by the mutation's onError
      toast.dismiss(toastId)
    }
  }, [
    url,
    destination,
    repoName,
    cloneProject,
    addProjectParentFolderId,
    closeCloneModal,
    setAddProjectDialogOpen,
  ])

  return (
    <Dialog open={cloneModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Clone Repository
          </DialogTitle>
          <DialogDescription>
            Clone a remote git repository by URL.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Git URL input */}
          <div className="space-y-1.5">
            <Label htmlFor="clone-url" className="text-xs">
              Repository URL
            </Label>
            <Input
              id="clone-url"
              placeholder="https://github.com/user/repo.git"
              value={url}
              onChange={e => setUrl(e.target.value)}
              disabled={cloneProject.isPending}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter' && url.trim() && destination) {
                  e.preventDefault()
                  handleClone()
                }
              }}
            />
          </div>

          {/* Destination picker */}
          <div className="space-y-1.5">
            <Label className="text-xs">Destination</Label>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 justify-start"
                onClick={handleBrowse}
                disabled={cloneProject.isPending}
              >
                <FolderOpen className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">
                  {destination || 'Choose destination...'}
                </span>
              </Button>
            </div>
            {destination && (
              <p className="truncate text-xs text-muted-foreground">
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
            disabled={
              cloneProject.isPending || !url.trim() || !destination
            }
          >
            {cloneProject.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default CloneProjectModal
