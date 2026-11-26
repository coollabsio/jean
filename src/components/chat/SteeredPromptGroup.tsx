import { memo, useCallback, useState } from 'react'
import { normalizePath } from '@/lib/path-utils'
import { cn } from '@/lib/utils'
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
import { MessageSettingsBadges } from './MessageSettingsBadges'
import {
  CopyIconButton,
  USER_CARD_BUBBLE_CLASS,
  USER_HOVER_REVEAL,
  USER_TAP_HIDDEN,
  copyPromptToClipboard,
} from './user-prompt-chrome'
import { useUIStore } from '@/store/ui-store'
import type { ChatMessage } from '@/types/chat'

/**
 * Right-aligned card grouping one or more user prompts that were steered
 * into a running turn (Codex `turn/steer`). Consecutive steered prompts
 * render as connected rows in a single bubble so they read as one batch.
 * `settings` is the prompt that started the turn: steers run with its
 * model and modes, so its settings show under the group like on prompts.
 */
export const SteeredPromptGroup = memo(function SteeredPromptGroup({
  texts,
  worktreePath,
  serverId,
  settings,
}: {
  texts: string[]
  worktreePath?: string
  serverId?: string
  settings?: ChatMessage
}) {
  const zenMode = useUIStore(state => state.zenMode)
  const [showDetails, setShowDetails] = useState(false)
  const handleBubbleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return
    setShowDetails(prev => !prev)
  }, [])
  const fullText = texts.join('\n\n')
  const handleCopy = useCallback(() => {
    void copyPromptToClipboard(fullText)
  }, [fullText])

  if (texts.length === 0) return null
  const model = settings?.model
  return (
    <div className="flex justify-end">
      <div className="group flex max-w-[85%] min-w-0 flex-col items-end gap-1 sm:max-w-[70%]">
        {/* react-doctor-disable-next-line react-doctor/no-static-element-interactions, react-doctor/click-events-have-key-events -- touch-only tap reveal; fine pointers/keyboard reveal details via group-hover/focus-within */}
        <div
          onClick={handleBubbleClick}
          className={cn(
            'max-w-full divide-y',
            USER_CARD_BUBBLE_CLASS,
            'divide-border/20 p-0'
          )}
        >
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
                className="min-w-0 break-words [overflow-wrap:anywhere] px-3 py-2"
              >
                {imagePaths.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {imagePaths.map((path, idx) => (
                      <ImageLightbox
                        key={path}
                        src={path}
                        serverId={serverId}
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
                          serverId={serverId}
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
        {!zenMode && (
          <div
            className={cn(
              'flex shrink-0 items-center gap-1 pr-0.5',
              USER_HOVER_REVEAL,
              !showDetails && USER_TAP_HIDDEN
            )}
          >
            {model && settings && (
              <MessageSettingsBadges
                model={model}
                executionMode={settings.execution_mode}
                thinkingLevel={settings.thinking_level}
                effortLevel={settings.effort_level}
                provider={settings.custom_profile_name}
                isCursor={model.startsWith('cursor/')}
              />
            )}
            <CopyIconButton label="Copy prompt" onClick={handleCopy} />
          </div>
        )}
      </div>
    </div>
  )
})
