import React from 'react'
import { Separator } from '@/components/ui/separator'
import { BackendLabel } from '@/components/ui/backend-label'
import type { CliBackend } from '@/types/preferences'
import { cn } from '@/lib/utils'

export interface SettingsSectionProps {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  anchorId?: string
  variant?: 'default' | 'card'
  children: React.ReactNode
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  actions,
  anchorId,
  variant = 'default',
  children,
}) => (
  <div
    id={anchorId}
    className={cn(
      'space-y-4',
      variant === 'card' &&
        'rounded-lg border p-4 sm:[&_.settings-inline-field]:justify-between sm:[&_.settings-inline-field>div:first-child]:w-auto'
    )}
  >
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h3
          className={cn(
            'font-medium text-foreground',
            variant === 'card' ? 'text-sm' : 'text-lg'
          )}
        >
          {title}
        </h3>
        {actions && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-2',
              variant === 'card' && 'sm:ml-auto'
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      {variant === 'default' && <Separator className="mt-2" />}
    </div>
    {children}
  </div>
)

export const BackendPaneHeader: React.FC<{
  backend: CliBackend
  description: React.ReactNode
}> = ({ backend, description }) => (
  <div>
    <h2 className="flex items-center gap-2 text-lg font-semibold">
      <BackendLabel backend={backend} />
    </h2>
    <p className="mt-1 text-sm text-muted-foreground">{description}</p>
  </div>
)
