import { Bot, LayoutList } from '@/components/icons/reicon'
import { CoordinatorView } from '@/components/agents/CoordinatorView'
import {
  SegmentedControl,
  type Segment,
} from '@/components/ui/segmented-control'
import { usePreferences } from '@/services/preferences'
import { useUIStore, type ProjectViewMode } from '@/store/ui-store'
import { isFolder, type Project } from '@/types/projects'
import { ProjectCanvasView } from './ProjectCanvasView'

const VIEW_SEGMENTS: readonly Segment<ProjectViewMode>[] = [
  { value: 'coordinator', label: 'Coordinator', icon: Bot },
  { value: 'sessions', label: 'Sessions', icon: LayoutList },
]

function ProjectViewSwitch({
  projectId,
  mode,
}: {
  projectId: string
  mode: ProjectViewMode
}) {
  return (
    <SegmentedControl
      value={mode}
      onChange={next =>
        useUIStore.getState().setProjectViewMode(projectId, next)
      }
      segments={VIEW_SEGMENTS}
      className="shrink-0 p-0.5"
    />
  )
}

/**
 * A project page. With Project Coordinator on, the user switches between the
 * coordinator chat and the list of sessions the coordinator started (last
 * choice per project; coordinator first). Without it, and for folders and
 * servers, it is the sessions canvas.
 */
export function ProjectView({
  projectId,
  project,
}: {
  projectId: string
  project: Project
}) {
  const { data: preferences } = usePreferences(project.serverId)
  const hasCoordinator =
    !!preferences?.coordinator_enabled && !project.server && !isFolder(project)
  const mode = useUIStore(
    state => state.projectViewModes[projectId] ?? 'coordinator'
  )

  if (!hasCoordinator)
    return <ProjectCanvasView projectId={projectId} project={project} />
  return (
    <CoordinatorView
      project={project}
      mode={mode}
      viewSwitch={<ProjectViewSwitch projectId={projectId} mode={mode} />}
      sessionModalHost={
        <ProjectCanvasView projectId={projectId} project={project} embedded />
      }
    />
  )
}
