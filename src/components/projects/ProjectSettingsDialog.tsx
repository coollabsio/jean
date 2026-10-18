import { useState, useCallback } from 'react'
import { Bot, Settings, Plug, FileJson, Cable } from '@/components/icons/reicon'
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
  SettingsPage,
  SettingsBackButton,
} from '@/components/preferences/SettingsPage'
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
import { AutoFixPane } from './panes/AutoFixPane'
import { IntegrationsPane } from './panes/IntegrationsPane'

type ProjectSettingsPane =
  | 'general'
  | 'integrations'
  | 'mcp-servers'
  | 'jean-json'
  | 'auto-fix'

const navigationItems = [
  { id: 'general' as const, name: 'General', icon: Settings },
  { id: 'integrations' as const, name: 'Integrations', icon: Cable },
  { id: 'auto-fix' as const, name: 'Mr. Robot', icon: Bot },
  { id: 'mcp-servers' as const, name: 'MCP Servers', icon: Plug },
  { id: 'jean-json' as const, name: 'Jean.json', icon: FileJson },
]

const getPaneTitle = (pane: ProjectSettingsPane): string => {
  switch (pane) {
    case 'general':
      return 'General'
    case 'integrations':
      return 'Integrations'
    case 'auto-fix':
      return 'Mr. Robot'
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
    <SettingsPage
      open
      onOpenChange={handleOpenChange}
      title={`Project Settings — ${project?.name ?? 'Project'}`}
    >
      <SidebarProvider className="!min-h-0 !h-full items-stretch overflow-hidden">
        <Sidebar
          collapsible="none"
          className="hidden md:flex border-r border-border"
        >
          <div
            className="flex h-14 shrink-0 items-center px-4 text-sm font-semibold"
            data-tauri-drag-region
            data-settings-title
          >
            Project settings
          </div>
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
                          type="button"
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
          <div className="shrink-0 border-t border-border p-2">
            <SettingsBackButton onClick={onClose} />
          </div>
        </Sidebar>

        <main className="flex flex-1 flex-col overflow-hidden">
          <header
            data-tauri-drag-region
            className="flex h-14 shrink-0 items-center gap-2"
          >
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
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={onClose}>
                        {project?.name ?? 'Project Settings'}
                      </button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{getPaneTitle(activePane)}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <ModalCloseButton
                className="hidden md:inline-flex ml-auto"
                onClick={() => handleOpenChange(false)}
              />
            </div>
          </header>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-8 lg:px-12 lg:py-10 min-h-0">
            {safeProjectId && projectPath && (
              <div
                key={activePane}
                className="mx-auto w-full min-w-0 max-w-4xl"
              >
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
                {activePane === 'integrations' && (
                  <IntegrationsPane projectId={safeProjectId} />
                )}
                {activePane === 'auto-fix' && (
                  <AutoFixPane projectId={safeProjectId} />
                )}
                {activePane === 'jean-json' && (
                  <JeanJsonPane
                    projectId={safeProjectId}
                    projectPath={projectPath}
                  />
                )}
              </div>
            )}
          </div>
        </main>
      </SidebarProvider>
    </SettingsPage>
  )
}
