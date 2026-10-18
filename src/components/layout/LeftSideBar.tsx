import { cn } from '@/lib/utils'
import { ProjectsSidebar } from '@/components/projects'
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
      {showAgents ? <AgentsSidebar /> : <ProjectsSidebar />}
      {children}
    </div>
  )
}

export default LeftSideBar
