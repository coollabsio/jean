import { useState } from 'react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { ChevronLeft, ChevronRight } from '@/components/icons/reicon'
import {
  DialogContent,
  DialogDescription,
  DialogTitle,
  PREVIEW_DIALOG_CONTENT_CLASS,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useImageSrc } from './use-image-src'
import { ZoomableImage } from './zoomable-image'
import { usePreviewStore } from '@/store/preview-store'

/** Thumbnails shown inline; the last one shows "+N" for the rest. */
const MAX_TILES = 3

/**
 * Image paths of a ```screenshots fenced block: one path or URL per line.
 * Tolerates list markers, backticks, and markdown image syntax.
 */
export function parseScreenshotPaths(source: string): string[] {
  return source
    .split('\n')
    .map(line =>
      line
        .trim()
        .replace(/^[-*]\s+/, '')
        .replace(/^!\[[^\]]*\]\((.*)\)$/, '$1')
        .replace(/^`(.*)`$/, '$1')
        .trim()
    )
    .filter(Boolean)
}

const SCREENSHOTS_BLOCK_RE =
  /^ {0,3}(`{3,}|~{3,})[ \t]*screenshots[ \t]*\n([\s\S]*?)^ {0,3}\1[ \t]*$\n?/gm

/**
 * Removes every ```screenshots block from markdown and returns their paths,
 * so a message can show all its screenshots in one gallery at the bottom.
 */
export function extractScreenshotBlocks(markdown: string): {
  text: string
  paths: string[]
} {
  const paths: string[] = []
  const text = markdown.replace(SCREENSHOTS_BLOCK_RE, (_, _fence, body) => {
    paths.push(...parseScreenshotPaths(body))
    return ''
  })
  return { text, paths }
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function Screenshot({
  path,
  serverId,
  className,
}: {
  path: string
  serverId?: string
  className?: string
}) {
  const src = useImageSrc(path, serverId)
  return src ? (
    <img
      src={src}
      alt={fileName(path)}
      className={className}
      loading="lazy"
      decoding="async"
    />
  ) : (
    <div className={cn('animate-pulse', className)} />
  )
}

/** Preview dialog content; arrow keys step through the screenshots. */
function ScreenshotGalleryContent({
  paths,
  serverId,
  initialIndex,
}: {
  paths: string[]
  serverId?: string
  initialIndex: number
}) {
  const [{ openIndex, direction }, setSlide] = useState({
    openIndex: initialIndex,
    direction: 0,
  })
  const step = (delta: 1 | -1) =>
    setSlide(({ openIndex: index }) => ({
      openIndex: (index + delta + paths.length) % paths.length,
      direction: delta,
    }))

  return (
    <DialogContent
      className={cn(
        PREVIEW_DIALOG_CONTENT_CLASS,
        'sm:max-h-[90vh] sm:!top-[5vh] sm:!bottom-auto'
      )}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft') step(-1)
        if (event.key === 'ArrowRight') step(1)
      }}
    >
      <VisuallyHidden>
        <DialogTitle>Screenshots</DialogTitle>
        <DialogDescription>Screenshot gallery</DialogDescription>
      </VisuallyHidden>
      <div className="flex h-full flex-col items-center justify-center gap-3 overflow-hidden px-4 pt-[calc(env(safe-area-inset-top)+3rem)] pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:p-0">
        <ZoomableImage
          key={`${openIndex}-${paths[openIndex]}`}
          onSwipe={paths.length > 1 ? step : undefined}
          className={cn(
            'min-h-0 w-full flex-1 sm:flex-none',
            direction !== 0 && 'animate-in fade-in-0 duration-200 ease-out',
            direction === 1 && 'slide-in-from-right',
            direction === -1 && 'slide-in-from-left'
          )}
        >
          <Screenshot
            path={paths[openIndex] ?? ''}
            serverId={serverId}
            className="max-h-[calc(90vh-6rem)] min-h-40 max-w-full rounded-md object-contain"
          />
        </ZoomableImage>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {paths.length > 1 && (
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous screenshot"
              className="rounded-md p-1.5 hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <span className="max-w-[60vw] truncate">
            {paths.length > 1 && `${openIndex + 1} / ${paths.length} · `}
            {fileName(paths[openIndex] ?? '')}
          </span>
          {paths.length > 1 && (
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next screenshot"
              className="rounded-md p-1.5 hover:bg-muted hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          )}
        </div>
      </div>
    </DialogContent>
  )
}

export function ScreenshotGallery({
  paths,
  serverId,
}: {
  paths: string[]
  serverId?: string
}) {
  const tiles = paths.slice(0, MAX_TILES)
  const hidden = paths.length - tiles.length

  return (
    <div
      className={cn(
        'my-4 grid gap-2',
        tiles.length === 1 && 'max-w-md grid-cols-1',
        tiles.length === 2 && 'grid-cols-2',
        tiles.length >= 3 && 'grid-cols-3'
      )}
    >
      {tiles.map((path, index) => {
        const moreCount = index === tiles.length - 1 ? hidden : 0
        return (
          <button
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- tiles are a fixed slice of the message; paths may repeat
            key={`${index}-${path}`}
            type="button"
            onClick={() =>
              usePreviewStore
                .getState()
                .openPreview(
                  <ScreenshotGalleryContent
                    paths={paths}
                    serverId={serverId}
                    initialIndex={index}
                  />
                )
            }
            aria-label={
              moreCount > 0
                ? `Open screenshots (${moreCount} more)`
                : `Open ${fileName(path)}`
            }
            className="group relative aspect-[16/10] cursor-pointer overflow-hidden rounded-xl border border-border/60 bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Screenshot
              path={path}
              serverId={serverId}
              className="size-full object-cover object-top transition-transform group-hover:scale-[1.02]"
            />
            {moreCount > 0 && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-2xl font-semibold text-white sm:text-3xl">
                +{moreCount}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
