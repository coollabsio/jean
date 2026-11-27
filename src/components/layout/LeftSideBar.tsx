import { cn } from '@/lib/utils'
import { ProjectsSidebar } from '@/components/projects'
import { SidebarTabs } from '@/components/projects/SidebarTabs'

interface LeftSideBarProps {
  children?: React.ReactNode
  className?: string
}

export function LeftSideBar({ children, className }: LeftSideBarProps) {
  return (
    <div className={cn('flex h-full flex-col bg-sidebar', className)}>
      <SidebarTabs />
      {/* Panels size themselves with h-full; this box gives them the rest */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ProjectsSidebar />
      </div>
      {children}
    </div>
  )
}

export default LeftSideBar
