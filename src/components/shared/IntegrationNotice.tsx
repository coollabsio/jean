import type { ComponentType, ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface IntegrationNoticeProps {
  icon: ComponentType<{ className?: string }>
  title: string
  description: ReactNode
  actionLabel: string
  onAction: () => void
}

/** Centered notice with one action, for integrations that need setup */
export function IntegrationNotice({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: IntegrationNoticeProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-3">
      <Icon className="h-5 w-5 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  )
}
