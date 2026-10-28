import { useState } from 'react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { ChevronLeft, ChevronRight } from '@/components/icons/reicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useImageSrc } from './use-image-src'

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

export function ScreenshotGallery({
  paths,
  serverId,
}: {
  paths: string[]
  serverId?: string
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const tiles = paths.slice(0, MAX_TILES)
  const hidden = paths.length - tiles.length
  const step = (delta: number) =>
    setOpenIndex(index =>
      index === null ? null : (index + delta + paths.length) % paths.length
    )

  return (
    <>
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
              key={`${index}-${path}`}
              type="button"
              onClick={() => setOpenIndex(index)}
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

      <Dialog
        open={openIndex !== null}
        onOpenChange={open => !open && setOpenIndex(null)}
      >
        <DialogContent
          className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[90vh] sm:!top-[5vh] sm:!translate-y-0 sm:!rounded-lg sm:p-4 bg-background/95"
          onKeyDown={event => {
            if (event.key === 'ArrowLeft') step(-1)
            if (event.key === 'ArrowRight') step(1)
          }}
        >
          <VisuallyHidden>
            <DialogTitle>Screenshots</DialogTitle>
            <DialogDescription>Screenshot gallery</DialogDescription>
          </VisuallyHidden>
          {openIndex !== null && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 sm:p-0">
              <Screenshot
                key={paths[openIndex]}
                path={paths[openIndex] ?? ''}
                serverId={serverId}
                className="max-h-[calc(90vh-6rem)] min-h-40 max-w-full rounded-md object-contain"
              />
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
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
