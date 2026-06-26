import { useState } from 'react'
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Image as ImageIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ToolArtifact, ToolArtifactAction } from './tool-artifacts'
import { copyToClipboard } from '@/lib/clipboard'
import { invoke } from '@/lib/transport'
import { cn } from '@/lib/utils'

interface ToolArtifactPreviewProps {
  artifacts: ToolArtifact[]
  onFileClick?: (filePath: string) => void
}

export function ToolArtifactPreview({
  artifacts,
  onFileClick,
}: ToolArtifactPreviewProps) {
  if (artifacts.length === 0) return null

  return (
    <div className="space-y-2">
      {artifacts.map(artifact => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          onFileClick={onFileClick}
        />
      ))}
    </div>
  )
}

function ArtifactCard({
  artifact,
  onFileClick,
}: {
  artifact: ToolArtifact
  onFileClick?: (filePath: string) => void
}) {
  const [previewFailed, setPreviewFailed] = useState(false)
  const hasActions = Boolean(artifact.actions?.length)

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-background/60">
      {artifact.type === 'image' && artifact.url ? (
        <div className="bg-muted/30 p-2">
          {previewFailed ? (
            <div
              role="status"
              className="rounded-md border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground"
            >
              Preview unavailable — use the action buttons below.
            </div>
          ) : (
            <img
              src={artifact.url}
              alt={artifact.alt ?? artifact.title}
              loading="lazy"
              fetchPriority="low"
              onError={() => setPreviewFailed(true)}
              className="max-h-72 w-full rounded-md object-contain"
            />
          )}
        </div>
      ) : null}
      <div className="flex min-w-0 items-start gap-2 p-2">
        {artifact.type === 'image' ? (
          <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : artifact.type === 'file' ? (
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">
            {artifact.title}
          </div>
          {artifact.subtitle ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {artifact.type === 'image' ? 'Preview' : artifact.subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {artifact.actions?.map(action => (
            <ArtifactActionButton
              key={`${action.label}-${action.url ?? action.path}`}
              action={action}
              onFileClick={onFileClick}
            />
          ))}
          {!hasActions && artifact.type === 'link' && artifact.url ? (
            <ArtifactActionButton
              action={{ label: 'Open', url: artifact.url }}
              onFileClick={onFileClick}
            />
          ) : null}
          {!hasActions && artifact.type === 'file' && artifact.path ? (
            <ArtifactActionButton
              action={{ label: 'Open file', path: artifact.path }}
              onFileClick={onFileClick}
            />
          ) : null}
          {artifact.type === 'file' && artifact.path ? (
            <>
              <CopyPathButton path={artifact.path} />
              <OpenFolderButton path={artifact.path} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ArtifactActionButton({
  action,
  onFileClick,
}: {
  action: ToolArtifactAction
  onFileClick?: (filePath: string) => void
}) {
  const className = artifactButtonClassName()

  if (action.url) {
    return (
      <a
        href={action.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {action.label}
      </a>
    )
  }

  if (action.path) {
    const path = action.path

    return (
      <button
        type="button"
        disabled={!onFileClick}
        onClick={() => onFileClick?.(path)}
        className={cn(className, !onFileClick && 'opacity-50')}
      >
        {action.label}
      </button>
    )
  }

  return null
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await copyToClipboard(path)
      setCopied(true)
      toast.success('Path copied')
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy artifact path:', error)
      toast.error('Failed to copy path')
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={artifactButtonClassName()}
      aria-label={`Copy path ${path}`}
    >
      {copied ? (
        <Check className="mr-1 h-3 w-3" />
      ) : (
        <Copy className="mr-1 h-3 w-3" />
      )}
      {copied ? 'Copied' : 'Copy path'}
    </button>
  )
}

function OpenFolderButton({ path }: { path: string }) {
  const handleOpenFolder = async () => {
    try {
      await invoke('open_worktree_in_finder', {
        worktreePath: containingFolder(path),
      })
    } catch (error) {
      console.error('Failed to open containing folder:', error)
      toast.error('Failed to open folder')
    }
  }

  return (
    <button
      type="button"
      onClick={handleOpenFolder}
      className={artifactButtonClassName()}
      aria-label={`Open containing folder for ${path}`}
    >
      <FolderOpen className="mr-1 h-3 w-3" />
      Open folder
    </button>
  )
}

function artifactButtonClassName(): string {
  return cn(
    'inline-flex h-7 items-center rounded-md border border-border/50 px-2',
    'text-[11px] font-medium text-foreground/80 transition-colors',
    'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  )
}

function containingFolder(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed) return '/'
  const separatorIndex = trimmed.lastIndexOf('/')
  return separatorIndex > 0 ? trimmed.slice(0, separatorIndex) : trimmed
}
