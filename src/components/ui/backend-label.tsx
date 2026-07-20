import type { ForwardRefExoticComponent, RefAttributes } from 'react'
import type { LucideProps } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ClaudeIcon } from '@/components/icons/ClaudeIcon'
import { CodexIcon } from '@/components/icons/CodexIcon'
import { OpenCodeIcon } from '@/components/icons/OpenCodeIcon'
import { CursorIcon } from '@/components/icons/CursorIcon'
import { PiIcon } from '@/components/icons/PiIcon'
import { CommandCodeIcon } from '@/components/icons/CommandCodeIcon'
import { GrokIcon } from '@/components/icons/GrokIcon'
import { KimiIcon } from '@/components/icons/KimiIcon'
import type { CliBackend } from '@/types/preferences'

export type BackendIconComponent = ForwardRefExoticComponent<
  LucideProps & RefAttributes<SVGSVGElement>
>

export function getBackendIcon(backend: CliBackend): BackendIconComponent {
  switch (backend) {
    case 'claude':
      return ClaudeIcon
    case 'codex':
      return CodexIcon
    case 'opencode':
      return OpenCodeIcon
    case 'cursor':
      return CursorIcon
    case 'pi':
      return PiIcon
    case 'commandcode':
      return CommandCodeIcon
    case 'grok':
      return GrokIcon
    case 'kimi':
      return KimiIcon
  }
}

export function getBackendLabel(backend: CliBackend): string {
  switch (backend) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'OpenCode'
    case 'cursor':
      return 'Cursor'
    case 'pi':
      return 'PI'
    case 'commandcode':
      return 'Command Code'
    case 'grok':
      return 'Grok'
    case 'kimi':
      return 'Kimi Code'
  }
}

export function isBetaBackend(backend: CliBackend): boolean {
  return (
    backend === 'pi' ||
    backend === 'commandcode' ||
    backend === 'grok' ||
    backend === 'kimi'
  )
}

export function getBackendPlainLabel(backend: CliBackend): string {
  return isBetaBackend(backend)
    ? `${getBackendLabel(backend)} (Beta)`
    : getBackendLabel(backend)
}

export function BackendLabel({
  backend,
  className,
  badgeClassName,
}: {
  backend: CliBackend
  className?: string
  badgeClassName?: string
}) {
  const label = getBackendLabel(backend)

  if (!isBetaBackend(backend)) return <span className={className}>{label}</span>

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span>{label}</span>
      <Badge
        aria-hidden="true"
        variant="outline"
        className={cn(
          'rounded-sm px-1.5 py-0 text-[10px] leading-4 uppercase tracking-wide bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/40',
          badgeClassName
        )}
      >
        Beta
      </Badge>
    </span>
  )
}
