import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { isServerApp, isClientApp } from '@/lib/environment'
import { invoke } from '@/lib/transport'
import { FolderOpen, FolderPlus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useProjectsStore } from '@/store/projects-store'
import { useAddProject, useInitProject } from '@/services/projects'

export function AddProjectDialog() {
  const {
    addProjectDialogOpen,
    addProjectParentFolderId,
    setAddProjectDialogOpen,
  } = useProjectsStore()
  const addProject = useAddProject()
  const initProject = useInitProject()

  const isPending = addProject.isPending || initProject.isPending

  const handleAddExisting = useCallback(async () => {
    if (!isServerApp()) {
      toast.error(
        isClientApp()
          ? 'Not available in client mode'
          : 'Not running in Tauri',
        {
          description: isClientApp()
            ? 'Projects are managed on the Jean server.'
            : 'Run the app with "bun run tauri:dev" to use native features.',
        }
      )
      return
    }

    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select a git repository',
      })

      if (selected && typeof selected === 'string') {
        try {
          await addProject.mutateAsync({
            path: selected,
            parentId: addProjectParentFolderId ?? undefined,
          })
          setAddProjectDialogOpen(false)
        } catch (error) {
          // Check if error is "not a git repository"
          const errorMessage =
            typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : ''

          if (
            errorMessage.includes('not a git repository') ||
            errorMessage.includes("ambiguous argument 'HEAD'")
          ) {
            // Open the git init modal instead of showing toast
            // This handles both: folder without git, and git repo without commits
            const { openGitInitModal } = useProjectsStore.getState()
            openGitInitModal(selected)
          }
          // Other errors are handled by mutation's onError (shows toast)
        }
      }
    } catch (error) {
      // User cancelled - don't show error
      if (error instanceof Error && error.message.includes('cancel')) {
        return
      }
      // Other errors handled by mutation
    }
  }, [addProject, addProjectParentFolderId, setAddProjectDialogOpen])

  const handleInitNew = useCallback(async () => {
    if (!isServerApp()) {
      toast.error(
        isClientApp()
          ? 'Not available in client mode'
          : 'Not running in Tauri',
        {
          description: isClientApp()
            ? 'Projects are managed on the Jean server.'
            : 'Run the app with "bun run tauri:dev" to use native features.',
        }
      )
      return
    }

    try {
      // Use save dialog to let user pick location and name for new project
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selected = await save({
        title: 'Create new project',
        defaultPath: 'my-project',
      })

      if (selected && typeof selected === 'string') {
        // Check if git identity is configured before init (commit requires it)
        try {
          const identity = await invoke<{
            name: string | null
            email: string | null
          }>('check_git_identity')
          if (!identity.name || !identity.email) {
            // Identity not configured - route through GitInitModal which handles identity setup
            const { openGitInitModal } = useProjectsStore.getState()
            openGitInitModal(selected)
            return
          }
        } catch {
          // If check fails, try anyway and let the error surface naturally
        }

        await initProject.mutateAsync({
          path: selected,
          parentId: addProjectParentFolderId ?? undefined,
        })
        setAddProjectDialogOpen(false)
      }
    } catch (error) {
      // User cancelled - don't show error
      if (error instanceof Error && error.message.includes('cancel')) {
        return
      }
      // Other errors handled by mutation
    }
  }, [initProject, addProjectParentFolderId, setAddProjectDialogOpen])

  // Keyboard shortcuts: A = add existing, I = initialize new
  useEffect(() => {
    if (!addProjectDialogOpen || isPending) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        handleAddExisting()
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault()
        handleInitNew()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [addProjectDialogOpen, isPending, handleAddExisting, handleInitNew])

  return (
    <Dialog open={addProjectDialogOpen} onOpenChange={setAddProjectDialogOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Add an existing git repository or create a new one.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-4">
          <button
            onClick={handleAddExisting}
            disabled={isPending}
            className="flex items-start gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <FolderOpen className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium leading-none">
                Add Existing Project
              </p>
              <p className="text-sm text-muted-foreground">
                Select a git repository from your computer
              </p>
            </div>
            <Kbd className="mt-1 h-6 px-1.5 text-xs shrink-0">A</Kbd>
          </button>

          <button
            onClick={handleInitNew}
            disabled={isPending}
            className="flex items-start gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <FolderPlus className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium leading-none">
                Initialize New Project
              </p>
              <p className="text-sm text-muted-foreground">
                Create a new directory with git initialized
              </p>
            </div>
            <Kbd className="mt-1 h-6 px-1.5 text-xs shrink-0">I</Kbd>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
