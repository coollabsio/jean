import { useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, GitBranch, FolderOpen, AlertCircle } from 'lucide-react'
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
import { useInitGitInFolder, useAddProject } from '@/services/projects'
import { getFilename } from '@/lib/path-utils'

interface GitIdentity {
  name: string | null
  email: string | null
}

export function GitInitModal() {
  const {
    gitInitModalOpen,
    gitInitModalPath,
    closeGitInitModal,
    setAddProjectDialogOpen,
    addProjectParentFolderId,
  } = useProjectsStore()

  const initGit = useInitGitInFolder()
  const addProject = useAddProject()

  const [error, setError] = useState<string | null>(null)
  const [identityChecked, setIdentityChecked] = useState(false)
  const [needsIdentity, setNeedsIdentity] = useState(false)
  const [gitName, setGitName] = useState('')
  const [gitEmail, setGitEmail] = useState('')
  const [savingIdentity, setSavingIdentity] = useState(false)

  const folderName = gitInitModalPath ? getFilename(gitInitModalPath) : ''

  // Check git identity when modal opens
  useEffect(() => {
    if (!gitInitModalOpen) {
      // Reset state when modal closes
      setIdentityChecked(false)
      setNeedsIdentity(false)
      setGitName('')
      setGitEmail('')
      setError(null)
      return
    }

    invoke<GitIdentity>('check_git_identity')
      .then(identity => {
        const missing = !identity.name || !identity.email
        setNeedsIdentity(missing)
        if (identity.name) setGitName(identity.name)
        if (identity.email) setGitEmail(identity.email)
        setIdentityChecked(true)
      })
      .catch(() => {
        // If check fails, assume identity is needed
        setNeedsIdentity(true)
        setIdentityChecked(true)
      })
  }, [gitInitModalOpen])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setError(null)
        closeGitInitModal()
      }
    },
    [closeGitInitModal]
  )

  const handleInitialize = useCallback(async () => {
    if (!gitInitModalPath) return

    setError(null)

    try {
      // Step 0: Set git identity if needed
      if (needsIdentity) {
        if (!gitName.trim() || !gitEmail.trim()) {
          setError('Please enter your name and email for git commits.')
          return
        }
        setSavingIdentity(true)
        try {
          await invoke('set_git_identity', {
            name: gitName.trim(),
            email: gitEmail.trim(),
          })
        } finally {
          setSavingIdentity(false)
        }
      }

      // Step 1: Initialize git
      await initGit.mutateAsync(gitInitModalPath)

      // Step 2: Add as project (with parent folder if adding into a folder)
      await addProject.mutateAsync({
        path: gitInitModalPath,
        parentId: addProjectParentFolderId ?? undefined,
      })

      // Close both dialogs on success
      closeGitInitModal()
      setAddProjectDialogOpen(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    }
  }, [
    gitInitModalPath,
    needsIdentity,
    gitName,
    gitEmail,
    initGit,
    addProject,
    addProjectParentFolderId,
    closeGitInitModal,
    setAddProjectDialogOpen,
  ])

  const isPending = savingIdentity || initGit.isPending || addProject.isPending

  return (
    <Dialog open={gitInitModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Initialize Git Repository
          </DialogTitle>
          <DialogDescription>
            The selected folder is not a git repository.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Folder path display */}
          <div className="flex items-center gap-3 rounded-lg bg-muted p-3">
            <FolderOpen className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate font-medium">{folderName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {gitInitModalPath}
              </p>
            </div>
          </div>

          {/* Git identity fields - shown when not configured */}
          {identityChecked && needsIdentity && (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">Git identity not configured</p>
              <p className="text-xs text-muted-foreground">
                Git requires a name and email for commits. This will be saved
                globally.
              </p>
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label htmlFor="git-name" className="text-xs">
                    Name
                  </Label>
                  <Input
                    id="git-name"
                    placeholder="Your Name"
                    value={gitName}
                    onChange={e => setGitName(e.target.value)}
                    disabled={isPending}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="git-email" className="text-xs">
                    Email
                  </Label>
                  <Input
                    id="git-email"
                    type="email"
                    placeholder="you@example.com"
                    value={gitEmail}
                    onChange={e => setGitEmail(e.target.value)}
                    disabled={isPending}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Description of what will happen */}
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Jean will initialize git in this folder:</p>
            <ul className="ml-2 list-inside list-disc space-y-1">
              <li>
                Run <code className="rounded bg-muted px-1">git init</code>
              </li>
              <li>Stage all existing files</li>
              <li>Create an initial commit</li>
            </ul>
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
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleInitialize}
            disabled={
              isPending ||
              (identityChecked &&
                needsIdentity &&
                (!gitName.trim() || !gitEmail.trim()))
            }
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {savingIdentity
              ? 'Setting identity...'
              : initGit.isPending
                ? 'Initializing...'
                : addProject.isPending
                  ? 'Adding project...'
                  : 'Initialize Git'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default GitInitModal
