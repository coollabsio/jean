import { useCallback, useMemo, useRef, useState } from 'react'
import { Link2, X, Search, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useProjects, useUpdateProjectSettings } from '@/services/projects'
import { isFolder, type Project } from '@/types/projects'

interface LinkedProjectsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
}

export function LinkedProjectsModal({
  open,
  onOpenChange,
  projectId,
}: LinkedProjectsModalProps) {
  const { data: projects } = useProjects()
  const updateSettings = useUpdateProjectSettings()
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const currentProject = useMemo(
    () => projects?.find(p => p.id === projectId) ?? null,
    [projects, projectId]
  )

  const linkedIds = useMemo(
    () => new Set(currentProject?.linked_project_ids ?? []),
    [currentProject?.linked_project_ids]
  )

  const linkedProjects = useMemo(
    () => (projects ?? []).filter(p => linkedIds.has(p.id)),
    [projects, linkedIds]
  )

  const availableProjects = useMemo(() => {
    const q = search.toLowerCase().trim()
    return (projects ?? []).filter(p => {
      if (isFolder(p)) return false
      if (p.id === projectId) return false
      if (linkedIds.has(p.id)) return false
      if (q && !p.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [projects, projectId, linkedIds, search])

  const updateLinks = useCallback(
    (newIds: string[]) => {
      if (!projectId) return
      updateSettings.mutate(
        { projectId, linkedProjectIds: newIds },
        {
          onError: err => {
            toast.error(`Failed to update linked projects: ${err}`)
          },
        }
      )
    },
    [projectId, updateSettings]
  )

  const handleAdd = useCallback(
    (project: Project) => {
      const newIds = [...(currentProject?.linked_project_ids ?? []), project.id]
      updateLinks(newIds)
      setSearch('')
    },
    [currentProject?.linked_project_ids, updateLinks]
  )

  const handleRemove = useCallback(
    (removeId: string) => {
      const newIds = (currentProject?.linked_project_ids ?? []).filter(
        id => id !== removeId
      )
      updateLinks(newIds)
    },
    [currentProject?.linked_project_ids, updateLinks]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md font-sans"
        onOpenAutoFocus={e => {
          e.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            Linked Projects
          </DialogTitle>
        </DialogHeader>

        {/* Current linked projects */}
        {linkedProjects.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground font-medium">
              Linked
            </span>
            <div className="space-y-1">
              {linkedProjects.map(p => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="truncate">{p.name}</span>
                  <button
                    onClick={() => handleRemove(p.id)}
                    className="ml-2 shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search + add */}
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground font-medium">
            Add project
          </span>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search projects..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <ScrollArea className="max-h-48">
            {availableProjects.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                {search
                  ? 'No matching projects'
                  : 'No projects available to link'}
              </p>
            ) : (
              <div className="space-y-0.5 py-1">
                {availableProjects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => handleAdd(p)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent transition-colors cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {!projectId && (
          <p className="text-xs text-muted-foreground text-center">
            No project selected
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default LinkedProjectsModal
