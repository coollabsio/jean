import { useEffect, useState } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export interface AcpLightboxImage {
  data: string
  mimeType: string
}

interface AcpImageLightboxProps {
  images: AcpLightboxImage[]
  initialIndex?: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Full-screen lightbox for ACP base64 images. Supports keyboard navigation
 * (← →) and multi-image browsing with a dot indicator.
 */
export function AcpImageLightbox({
  images,
  initialIndex = 0,
  open,
  onOpenChange,
}: AcpImageLightboxProps) {
  const [index, setIndex] = useState(initialIndex)

  useEffect(() => {
    if (open) setIndex(initialIndex)
  }, [open, initialIndex])

  useEffect(() => {
    if (!open || images.length <= 1) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1))
      if (e.key === 'ArrowRight')
        setIndex(i => Math.min(images.length - 1, i + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, images.length])

  const img = images[index]
  if (!img) return null

  const src = `data:${img.mimeType};base64,${img.data}`
  const multi = images.length > 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!w-screen !h-dvh !max-w-none !max-h-none !rounded-none p-0 border-0 bg-black/90 backdrop-blur-md flex items-center justify-center cursor-zoom-out"
        showCloseButton={false}
        onClick={() => onOpenChange(false)}
      >
        <VisuallyHidden>
          <DialogTitle>Image preview</DialogTitle>
          <DialogDescription>
            {multi ? `Image ${index + 1} of ${images.length}` : 'Image preview'}
          </DialogDescription>
        </VisuallyHidden>

        {/* Close */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute top-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Prev */}
        {multi && index > 0 && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setIndex(i => i - 1)
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            aria-label="Previous image"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        {/* Next */}
        {multi && index < images.length - 1 && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setIndex(i => i + 1)
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            aria-label="Next image"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}

        {/* Image */}
        <img
          key={src}
          src={src}
          alt=""
          className="max-h-[calc(100dvh-6rem)] max-w-[calc(100vw-6rem)] object-contain rounded-md cursor-default"
          onClick={e => e.stopPropagation()}
        />

        {/* Dot indicator */}
        {multi && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex gap-1.5">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  setIndex(i)
                }}
                aria-label={`Go to image ${i + 1}`}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === index
                    ? 'w-4 bg-white'
                    : 'w-1.5 bg-white/40 hover:bg-white/60'
                )}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
