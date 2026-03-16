import { useCallback } from 'react'
import { X, Loader2 } from 'lucide-react'
import { invoke } from '@/lib/transport'
import type { PendingImage } from '@/types/chat'
import { ImageLightbox } from './ImageLightbox'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

interface ImagePreviewProps {
  /** Array of pending images to display */
  images: PendingImage[]
  /** Callback when user removes an image */
  onRemove: (imageId: string) => void
  /** Whether removal is disabled (e.g., while sending) */
  disabled?: boolean
}

/**
 * Displays thumbnails of pending image attachments before sending
 * Renders above the chat input area
 */
export function ImagePreview({
  images,
  onRemove,
  disabled,
}: ImagePreviewProps) {
  const handleRemove = useCallback(
    async (e: React.MouseEvent, image: PendingImage) => {
      // Prevent the click from bubbling to the lightbox
      e.stopPropagation()

      if (disabled) return

      // Delete the file from disk
      try {
        await invoke('delete_pasted_image', { path: image.path })
      } catch (error) {
        console.error('Failed to delete image:', error)
        // Still remove from UI even if delete fails
      }

      // Remove from store
      onRemove(image.id)
    },
    [disabled, onRemove]
  )

  if (images.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 px-4 py-2 md:px-6">
      {images.map(image => (
        <div key={image.id} className="relative group">
          {image.loading ? (
            <div className="h-16 w-16 rounded-md border border-border/50 bg-muted flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <ImageLightbox
                src={image.path}
                alt={image.filename}
                thumbnailClassName="h-16 w-16 object-cover rounded-md border border-border/50 bg-muted cursor-pointer hover:border-primary/50 transition-colors"
              />
              {!disabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={e => handleRemove(e, image)}
                      className="absolute -top-1.5 -right-1.5 p-0.5 bg-destructive text-destructive-foreground rounded-full opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shadow-sm hover:bg-destructive/90 z-10"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Remove image</TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
