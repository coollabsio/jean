import { cn } from '@/lib/utils'
import { ProjectsSidebar } from '@/components/projects'

interface LeftSideBarProps {
  children?: React.ReactNode
  className?: string
}

export function LeftSideBar({ children, className }: LeftSideBarProps) {
  return (
    <div className={cn('flex h-full flex-col bg-sidebar', className)}>
      <ProjectsSidebar />
      {children}
    </div>
  )
}

export default LeftSideBar
