import type { ReactNode } from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import { openExternal } from '@/lib/platform'
import { invoke } from '@/lib/transport'
import { cn } from '@/lib/utils'
import { looksLikeFilePath, resolveFilePath } from '@/lib/link-utils'
import type { AppPreferences } from '@/types/preferences'

interface SmartLinkProps {
  href?: string
  children: ReactNode
  worktreePath?: string | null
  editor?: AppPreferences['editor']
  onOpenFile?: ((filePath: string, line?: number, column?: number) => void) | null
}

export function SmartLink({
  href,
  children,
  worktreePath,
  editor,
  onOpenFile,
}: SmartLinkProps) {
  const target = href ?? ''
  const isFile = looksLikeFilePath(target)

  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!target) return
    event.preventDefault()

    if (isFile) {
      const resolved = resolveFilePath(target, worktreePath)
      if (!resolved) return

      if (onOpenFile) {
        onOpenFile(resolved.filePath, resolved.line, resolved.column)
        return
      }

      await invoke('open_file_in_default_app', {
        path: resolved.filePath,
        editor,
        line: resolved.line,
        column: resolved.column,
      })
      return
    }

    await openExternal(target)
  }

  return (
    <a
      href={target}
      onClick={handleClick}
      className={cn(
        'inline-flex items-baseline gap-1 underline underline-offset-2 hover:text-foreground',
        isFile && 'font-medium'
      )}
      target={isFile ? undefined : '_blank'}
      rel="noopener noreferrer"
      title={isFile ? 'Open file' : undefined}
    >
      {isFile ? (
        <FileText className="relative top-0.5 size-3 shrink-0" />
      ) : (
        <ExternalLink className="relative top-0.5 size-3 shrink-0" />
      )}
      <span>{children}</span>
    </a>
  )
}
