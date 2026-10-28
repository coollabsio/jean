import { memo } from 'react'
import { normalizePath } from '@/lib/path-utils'
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
  worktreePath,
  serverId,
}: {
  texts: string[]
  worktreePath?: string
  serverId?: string
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
              className="min-w-0 px-3 py-2 text-foreground break-words [overflow-wrap:anywhere]"
            >
              {imagePaths.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {imagePaths.map((path, idx) => (
                    <ImageLightbox
                      key={path}
                      src={path}
                      alt={`Attached image ${idx + 1}`}
                      thumbnailClassName="h-20 max-w-40 object-contain rounded border border-border/50 cursor-pointer hover:border-foreground/20 transition-colors"
                    />
                  ))}
                </div>
              )}

              {textFilePaths.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {textFilePaths.map(path => (
                    <TextFileLightbox
                      key={path}
                      path={path}
                      serverId={serverId}
                    />
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
                        serverId={serverId}
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
