import { cn } from '@/lib/utils'
import { ProjectsSidebar } from '@/components/projects'
import { SidebarTabs } from '@/components/projects/SidebarTabs'
import { AgentsSidebar } from '@/components/agents/AgentsSidebar'
import { useShowAgents } from '@/components/agents/agents-feature'

interface LeftSideBarProps {
  children?: React.ReactNode
  className?: string
}

export function LeftSideBar({ children, className }: LeftSideBarProps) {
  const showAgents = useShowAgents()
  return (
    <div
      className={cn(
        'flex h-full flex-col bg-sidebar dark:bg-[#0b0b0b]',
        className
      )}
    >
      <SidebarTabs />
      {/* Panels size themselves with h-full; this box gives them the rest */}
      <div className="flex min-h-0 flex-1 flex-col">
        {showAgents ? <AgentsSidebar /> : <ProjectsSidebar />}
      </div>
      {children}
    </div>
  )
}

export default LeftSideBar
