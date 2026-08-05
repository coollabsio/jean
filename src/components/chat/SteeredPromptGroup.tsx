import { memo } from 'react'
import { Copy } from 'lucide-react'
import { normalizePath } from '@/lib/path-utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ImageLightbox } from './ImageLightbox'
import { TextFileLightbox } from './TextFileLightbox'
import { FileMentionBadge } from './FileMentionBadge'
import { SkillBadge } from './SkillBadge'
import {
  extractImagePaths,
  extractTextFilePaths,
  extractFileMentionPaths,
  extractDirectoryMentionPaths,
  extractSkillPaths,
  stripAllMarkers,
} from './message-content-utils'

/**
 * Right-aligned card grouping one or more user prompts that were steered
 * into a running turn (Codex `turn/steer`). Consecutive steered prompts
 * render as connected rows in a single bubble so they read as one batch.
 */
export const SteeredPromptGroup = memo(function SteeredPromptGroup({
  texts,
  onCopyText,
  worktreePath,
}: {
  texts: string[]
  onCopyText?: (text: string) => void
  worktreePath?: string
}) {
  if (texts.length === 0) return null
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] min-w-0 sm:max-w-[70%] rounded-lg border border-border bg-muted/20 divide-y divide-border/60">
        {texts.map((text, textIndex) => {
          const imagePaths = extractImagePaths(text)
          const textFilePaths = extractTextFilePaths(text)
          const fileMentionPaths = extractFileMentionPaths(text)
          const directoryMentionPaths = extractDirectoryMentionPaths(text)
          const skillPaths = extractSkillPaths(text)
          const displayText = stripAllMarkers(text)
          // Content identity: full text is stable once a steered prompt is added
          // (list is append-only). Prefix with occurrence of identical texts.
          const sameTextBefore = texts
            .slice(0, textIndex)
            .filter(t => t === text).length
          const textKey =
            sameTextBefore === 0 ? text : `${text}#${sameTextBefore}`

          return (
            <div
              key={textKey}
              className="relative group/steered min-w-0 px-3 py-2 text-foreground break-words [overflow-wrap:anywhere]"
            >
              {onCopyText && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Copy steered prompt"
                      onClick={() => onCopyText(text)}
                      className="absolute right-full top-2 mr-1 p-1 rounded cursor-pointer text-muted-foreground/0 [@media(pointer:coarse)]:text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50 group-hover/steered:text-muted-foreground/50 transition-colors"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Copy to clipboard</TooltipContent>
                </Tooltip>
              )}

              {imagePaths.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {imagePaths.map((path, idx) => (
                    <ImageLightbox
                      key={path}
                      src={path}
                      alt={`Attached image ${idx + 1}`}
                      thumbnailClassName="h-20 max-w-40 object-contain rounded border border-border/50 cursor-pointer hover:border-primary/50 transition-colors"
                    />
                  ))}
                </div>
              )}

              {textFilePaths.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {textFilePaths.map(path => (
                    <TextFileLightbox key={path} path={path} />
                  ))}
                </div>
              )}

              {worktreePath &&
                (fileMentionPaths.length > 0 ||
                  directoryMentionPaths.length > 0) && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {directoryMentionPaths.map(path => (
                      <FileMentionBadge
                        key={`dir:${path}`}
                        path={path}
                        worktreePath={worktreePath}
                        isDirectory
                      />
                    ))}
                    {fileMentionPaths.map(path => (
                      <FileMentionBadge
                        key={`file:${path}`}
                        path={path}
                        worktreePath={worktreePath}
                      />
                    ))}
                  </div>
                )}

              {skillPaths.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {skillPaths.map(path => {
                    const parts = normalizePath(path).split('/')
                    const skillsIdx = parts.findIndex(p => p === 'skills')
                    const name =
                      skillsIdx >= 0 && parts[skillsIdx + 1]
                        ? parts[skillsIdx + 1]
                        : path
                    return (
                      <SkillBadge
                        key={path}
                        skill={{
                          id: path,
                          name: name ?? path,
                          path,
                        }}
                        compact
                      />
                    )
                  })}
                </div>
              )}

              {displayText && (
                <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {displayText}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})
