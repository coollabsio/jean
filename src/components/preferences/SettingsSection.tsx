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
  variant = 'card',
  children,
}) => (
  <div id={anchorId} className="min-w-0 space-y-3">
    <div className={variant === 'card' ? 'px-1 sm:px-2' : undefined}>
      <div className="flex flex-wrap items-center gap-3">
        <h3
          className={cn(
            'font-medium text-foreground',
            variant === 'card' ? 'text-base' : 'text-lg'
          )}
        >
          {title}
        </h3>
        {actions && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-2',
              variant === 'card' && 'ml-auto'
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
    <div
      className={cn(
        'space-y-4',
        variant === 'card' &&
          'min-w-0 rounded-xl border border-border bg-muted/30 p-4 sm:p-5 sm:[&_.settings-inline-field]:flex-wrap sm:[&_.settings-inline-field]:justify-between sm:[&_.settings-inline-field>div:first-child]:w-auto [&_.settings-inline-field>div:first-child]:min-w-32 [&_.settings-inline-field>div:first-child]:flex-1 [&_.settings-inline-field>div:first-child]:break-words'
      )}
    >
      {children}
    </div>
  </div>
)

export const BackendPaneHeader: React.FC<{
  backend: CliBackend
  description?: React.ReactNode
}> = ({ backend, description }) => (
  <div>
    <h2 className="flex items-center gap-2 text-lg font-semibold">
      <BackendLabel backend={backend} />
    </h2>
    {description && (
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    )}
  </div>
)
