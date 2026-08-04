import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { cn } from '@/lib/utils'

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
  const [selectedIndex, setSelectedIndex] = useState(0)
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

  useEffect(() => {
    if (!open) {
      setSearch('')
      setSelectedIndex(0)
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(index => {
      if (availableProjects.length === 0) return 0
      return Math.min(index, availableProjects.length - 1)
    })
  }, [availableProjects.length])

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
      setSelectedIndex(0)
    },
    [currentProject?.linked_project_ids, updateLinks]
  )

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (availableProjects.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(index => (index + 1) % availableProjects.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(
          index =>
            (index - 1 + availableProjects.length) % availableProjects.length
        )
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const project = availableProjects[selectedIndex]
        if (project) {
          handleAdd(project)
        }
      }
    },
    [availableProjects, selectedIndex, handleAdd]
  )

  const selectedProjectId = availableProjects[selectedIndex]?.id

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
                    type="button"
                    onClick={() => handleRemove(p.id)}
                    aria-label={`Unlink ${p.name}`}
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
              aria-label="Search projects"
              value={search}
              onChange={e => {
                setSearch(e.target.value)
                setSelectedIndex(0)
              }}
              onKeyDown={handleSearchKeyDown}
              role="combobox"
              aria-expanded={availableProjects.length > 0}
              aria-controls="linked-projects-listbox"
              aria-activedescendant={
                selectedProjectId
                  ? `linked-project-option-${selectedProjectId}`
                  : undefined
              }
              className="w-full rounded-md border border-border bg-muted/40 pl-8 pr-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/40 dark:bg-input/50 md:text-sm"
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
              <div
                id="linked-projects-listbox"
                role="listbox"
                className="space-y-0.5 py-1"
              >
                {availableProjects.map((p, index) => {
                  const isSelected = index === selectedIndex

                  return (
                    <button
                      type="button"
                      key={p.id}
                      id={`linked-project-option-${p.id}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleAdd(p)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors cursor-pointer',
                        'hover:bg-accent hover:text-accent-foreground focus:outline-none',
                        isSelected && 'bg-accent text-accent-foreground'
                      )}
                    >
                      <Plus
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          isSelected
                            ? 'text-accent-foreground'
                            : 'text-muted-foreground'
                        )}
                      />
                      <span className="truncate">{p.name}</span>
                    </button>
                  )
                })}
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
