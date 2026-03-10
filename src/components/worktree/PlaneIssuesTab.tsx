import { useState, useEffect } from 'react'
import { Loader2, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { isPlaneAuthError } from '@/services/plane'
import { PlaneAuthError } from '@/components/shared/PlaneAuthError'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PlaneIssueItem } from './PlaneIssueItem'
import type { PlaneIssue, PlaneWorkspace, PlaneProject } from '@/types/plane'
import { usePlaneWorkspaces, usePlaneProjects, usePlaneIssues } from '@/services/plane'
import { useSelectedProject } from '@/services/projects'

export interface PlaneIssuesTabProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  onSelectIssue: (issue: PlaneIssue, background?: boolean) => void
  onInvestigateIssue: (issue: PlaneIssue, background?: boolean) => void
  onPreviewIssue?: (issue: PlaneIssue) => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  creatingFromId: string | null
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

export function PlaneIssuesTab({
  searchQuery,
  setSearchQuery,
  onSelectIssue,
  onInvestigateIssue,
  onPreviewIssue,
  selectedIndex,
  setSelectedIndex,
  creatingFromId,
  searchInputRef,
}: PlaneIssuesTabProps) {
  const { data: selectedProject } = useSelectedProject()
  const projectId = selectedProject?.id ?? null

  // Workspace selection
  const { data: workspaces = [], isLoading: isLoadingWorkspaces, error: errorWorkspaces } = usePlaneWorkspaces(projectId)
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = useState<string | null>(null)

  // Auto-select first workspace if only one available
  useEffect(() => {
    if (workspaces.length === 1 && !selectedWorkspaceSlug) {
      setSelectedWorkspaceSlug(workspaces[0].slug)
    }
  }, [workspaces, selectedWorkspaceSlug])

  // Project selection within workspace
  const { data: projects = [], isLoading: isLoadingProjects } = usePlaneProjects(
    projectId,
    selectedWorkspaceSlug,
    { enabled: !!selectedWorkspaceSlug }
  )
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  // Issues list
  const { data: issuesData, isLoading: isLoadingIssues, error: errorIssues, refetch: refetchIssues } = usePlaneIssues(
    projectId,
    selectedWorkspaceSlug,
    selectedProjectId,
    { enabled: !!selectedWorkspaceSlug }
  )

  const issues = issuesData?.issues ?? []
  const isLoading = isLoadingWorkspaces || isLoadingProjects || isLoadingIssues
  const error = errorWorkspaces || errorIssues

  // Filter issues based on search query
  const filteredIssues = searchQuery.trim()
    ? issues.filter(issue => {
        const query = searchQuery.toLowerCase()
        return (
          issue.sequenceId.toLowerCase().includes(query) ||
          issue.name.toLowerCase().includes(query) ||
          issue.description?.toLowerCase().includes(query)
        )
      })
    : issues

  // Refresh handler
  const handleRefresh = () => {
    if (selectedWorkspaceSlug) {
      refetchIssues()
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Workspace & Project Selection */}
      <div className="p-3 space-y-2 border-b border-border">
        {/* Workspace selector */}
        <select
          value={selectedWorkspaceSlug ?? ''}
          onChange={e => {
            setSelectedWorkspaceSlug(e.target.value || null)
            setSelectedProjectId(null)
          }}
          className="w-full h-8 px-2 text-sm bg-background border border-input rounded-md"
          disabled={isLoadingWorkspaces}
        >
          <option value="">Select workspace...</option>
          {workspaces.map(ws => (
            <option key={ws.id} value={ws.slug}>
              {ws.name}
            </option>
          ))}
        </select>

        {/* Project selector */}
        {selectedWorkspaceSlug && (
          <select
            value={selectedProjectId ?? ''}
            onChange={e => setSelectedProjectId(e.target.value || null)}
            className="w-full h-8 px-2 text-sm bg-background border border-input rounded-md"
            disabled={isLoadingProjects}
          >
            <option value="">All projects...</option>
            {projects.map(proj => (
              <option key={proj.id} value={proj.id}>
                {proj.name} ({proj.identifier})
              </option>
            ))}
          </select>
        )}

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search issues by identifier, title, or description..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRefresh}
                disabled={!selectedWorkspaceSlug || isLoadingIssues}
                className={cn(
                  'flex items-center justify-center h-8 w-8 rounded-md border border-border',
                  'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                  'transition-colors',
                  (!selectedWorkspaceSlug || isLoadingIssues) && 'opacity-50 cursor-not-allowed'
                )}
              >
                <RefreshCw
                  className={cn(
                    'h-4 w-4 text-muted-foreground',
                    isLoadingIssues && 'animate-spin'
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>Refresh issues</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Issues list */}
      <ScrollArea className="flex-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              {isLoadingWorkspaces
                ? 'Loading workspaces...'
                : isLoadingProjects
                ? 'Loading projects...'
                : 'Loading issues...'}
            </span>
          </div>
        )}

        {error &&
          (isPlaneAuthError(error) ? (
            <PlaneAuthError />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="h-5 w-5 text-destructive mb-2" />
              <span className="text-sm text-muted-foreground">
                {error.message || 'Failed to load issues'}
              </span>
            </div>
          ))}

        {!isLoading && !error && !selectedWorkspaceSlug && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">
              Select a workspace to view issues
            </span>
          </div>
        )}

        {!isLoading && !error && selectedWorkspaceSlug && filteredIssues.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">
              {searchQuery
                ? 'No issues match your search'
                : 'No active issues found'}
            </span>
          </div>
        )}

        {!isLoading && !error && filteredIssues.length > 0 && (
          <div className="py-1">
            {filteredIssues.map((issue, index) => (
              <PlaneIssueItem
                key={issue.id}
                issue={issue}
                index={index}
                isSelected={index === selectedIndex}
                isCreating={creatingFromId === issue.id}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={bg => onSelectIssue(issue, bg)}
                onInvestigate={bg => onInvestigateIssue(issue, bg)}
                onPreview={onPreviewIssue ? () => onPreviewIssue(issue) : undefined}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
