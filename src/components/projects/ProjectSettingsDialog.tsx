import { useState, useCallback } from 'react'
import { Settings, Plug, FileJson } from 'lucide-react'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { useProjectsStore } from '@/store/projects-store'
import { useProjects } from '@/services/projects'
import { GeneralPane } from './panes/GeneralPane'
import { McpServersPane } from './panes/McpServersPane'
import { JeanJsonPane } from './panes/JeanJsonPane'

type ProjectSettingsPane = 'general' | 'mcp-servers' | 'jean-json'

const navigationItems = [
  { id: 'general' as const, name: 'General', icon: Settings },
  { id: 'mcp-servers' as const, name: 'MCP Servers', icon: Plug },
  { id: 'jean-json' as const, name: 'Jean.json', icon: FileJson },
]

const getPaneTitle = (pane: ProjectSettingsPane): string => {
  switch (pane) {
    case 'general':
      return 'General'
    case 'mcp-servers':
      return 'MCP Servers'
    case 'jean-json':
      return 'Jean.json'
  }
}

export function ProjectSettingsDialog() {
  const {
    projectSettingsDialogOpen,
    projectSettingsProjectId,
    projectSettingsInitialPane,
    closeProjectSettings,
  } = useProjectsStore()

  if (!projectSettingsDialogOpen) return null

  return (
    <ProjectSettingsDialogContent
      projectId={projectSettingsProjectId}
      initialPane={projectSettingsInitialPane}
      onClose={closeProjectSettings}
    />
  )
}

function ProjectSettingsDialogContent({
  projectId,
  initialPane,
  onClose,
}: {
  projectId: string | null
  initialPane: string | null
  onClose: () => void
}) {
  const validInitialPane =
    initialPane && navigationItems.some(item => item.id === initialPane)
      ? (initialPane as ProjectSettingsPane)
      : 'general'
  const [activePane, setActivePane] =
    useState<ProjectSettingsPane>(validInitialPane)

  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === projectId)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose()
    },
    [onClose]
  )

  const safeProjectId = projectId ?? ''
  const projectPath = project?.path ?? ''

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 !w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[85vh] sm:!rounded-xl font-sans"
      >
        <DialogTitle className="sr-only">
          Project Settings — {project?.name ?? 'Project'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Configure settings for this project.
        </DialogDescription>

        <SidebarProvider className="!min-h-0 !h-full items-stretch overflow-hidden">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationItems.map(item => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activePane === item.id}
                        >
                          <button
                            onClick={() => setActivePane(item.id)}
                            className="w-full"
                          >
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2">
              <div className="flex flex-1 items-center gap-2 px-4">
                {/* Mobile pane selector */}
                <Select
                  value={activePane}
                  onValueChange={v => setActivePane(v as ProjectSettingsPane)}
                >
                  <SelectTrigger className="md:hidden w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {navigationItems.map(item => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ModalCloseButton
                  size="lg"
                  className="md:hidden"
                  onClick={() => handleOpenChange(false)}
                />
                <Breadcrumb className="hidden md:block">
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <BreadcrumbLink href="#">
                        {project?.name ?? 'Project Settings'}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>
                        {getPaneTitle(activePane)}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
                <ModalCloseButton
                  className="hidden md:inline-flex ml-auto"
                  onClick={() => handleOpenChange(false)}
                />
              </div>
            </header>

            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 pt-0 min-h-0 custom-scrollbar">
              {safeProjectId && projectPath && (
                <>
                  {activePane === 'general' && (
                    <GeneralPane
                      projectId={safeProjectId}
                      projectPath={projectPath}
                    />
                  )}
                  {activePane === 'mcp-servers' && (
                    <McpServersPane
                      projectId={safeProjectId}
                      projectPath={projectPath}
                    />
                  )}
                  {activePane === 'jean-json' && (
                    <JeanJsonPane
                      projectId={safeProjectId}
                      projectPath={projectPath}
                    />
                  )}
                </>
              )}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
