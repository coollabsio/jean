import { useState, useCallback, useEffect } from 'react'
import {
  Settings,
  Palette,
  Keyboard,
  Wand2,
  Plug,
  Blocks,
  BarChart3,
  Puzzle,
  FlaskConical,
  Globe,
} from 'lucide-react'
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
import { ModalCloseButton } from '@/components/ui/modal-close-button'
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
import { useUIStore, type PreferencePane } from '@/store/ui-store'
import { GeneralPane } from './panes/GeneralPane'
import { AppearancePane } from './panes/AppearancePane'
import { KeybindingsPane } from './panes/KeybindingsPane'
import { MagicPromptsPane } from './panes/MagicPromptsPane'
import { McpServersPane } from './panes/McpServersPane'
import { ProvidersPane } from './panes/ProvidersPane'
import { UsagePane } from './panes/UsagePane'
import { IntegrationsPane } from './panes/IntegrationsPane'
import { ExperimentalPane } from './panes/ExperimentalPane'
import { WebAccessPane } from './panes/WebAccessPane'

const navigationItems = [
  {
    id: 'general' as const,
    name: 'General',
    icon: Settings,
  },
  {
    id: 'providers' as const,
    name: 'Providers',
    icon: Blocks,
  },
  {
    id: 'usage' as const,
    name: 'Usage',
    icon: BarChart3,
  },
  {
    id: 'appearance' as const,
    name: 'Appearance',
    icon: Palette,
  },
  {
    id: 'keybindings' as const,
    name: 'Keybindings',
    icon: Keyboard,
    desktopOnly: true,
  },
  {
    id: 'magic-prompts' as const,
    name: 'Magic Prompts',
    icon: Wand2,
  },
  {
    id: 'mcp-servers' as const,
    name: 'MCP Servers',
    icon: Plug,
  },
  {
    id: 'integrations' as const,
    name: 'Integrations',
    icon: Puzzle,
  },
  {
    id: 'experimental' as const,
    name: 'Experimental',
    icon: FlaskConical,
  },
  {
    id: 'web-access' as const,
    name: 'Web Access (Experimental)',
    icon: Globe,
    desktopOnly: true,
  },
]

const getPaneTitle = (pane: PreferencePane): string => {
  switch (pane) {
    case 'general':
      return 'General'
    case 'appearance':
      return 'Appearance'
    case 'keybindings':
      return 'Keybindings'
    case 'magic-prompts':
      return 'Magic Prompts'
    case 'mcp-servers':
      return 'MCP Servers'
    case 'providers':
      return 'Providers'
    case 'usage':
      return 'Usage'
    case 'integrations':
      return 'Integrations'
    case 'experimental':
      return 'Experimental'
    case 'web-access':
      return 'Web Access (Experimental)'
    default:
      return 'General'
  }
}

export function PreferencesDialog() {
  const [activePane, setActivePane] = useState<PreferencePane>('general')
  const preferencesOpen = useUIStore(state => state.preferencesOpen)
  const setPreferencesOpen = useUIStore(state => state.setPreferencesOpen)
  const preferencesPane = useUIStore(state => state.preferencesPane)

  // Handle open state change and navigate to specific pane if requested
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setActivePane('general')
      }
      setPreferencesOpen(open)
    },
    [setPreferencesOpen]
  )

  // Sync activePane from preferencesPane when dialog opens to a specific pane
  useEffect(() => {
    if (preferencesOpen && preferencesPane) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActivePane(preferencesPane)
    }
  }, [preferencesOpen, preferencesPane])

  return (
    <Dialog open={preferencesOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 !w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[85vh] sm:!rounded-xl font-sans"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your application preferences here.
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
                  onValueChange={v => setActivePane(v as PreferencePane)}
                >
                  <SelectTrigger className="md:hidden w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {navigationItems
                      .filter(item => !item.desktopOnly)
                      .map(item => (
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
                      <BreadcrumbLink href="#">Settings</BreadcrumbLink>
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
              {activePane === 'general' && <GeneralPane />}
              {activePane === 'appearance' && <AppearancePane />}
              {activePane === 'keybindings' && <KeybindingsPane />}
              {activePane === 'magic-prompts' && <MagicPromptsPane />}
              {activePane === 'mcp-servers' && <McpServersPane />}
              {activePane === 'providers' && <ProvidersPane />}
              {activePane === 'usage' && <UsagePane />}
              {activePane === 'integrations' && <IntegrationsPane />}
              {activePane === 'experimental' && <ExperimentalPane />}
              {activePane === 'web-access' && <WebAccessPane />}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}

export default PreferencesDialog
