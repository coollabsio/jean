import { useState, useCallback } from 'react'
import { convertFileSrc } from '@/lib/transport'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'

interface ImageLightboxProps {
  /** File path to the image */
  src: string
  /** Alt text for accessibility */
  alt: string
  /** Thumbnail className */
  thumbnailClassName?: string
  /** Optional wrapper className */
  className?: string
  /** Children to render as the clickable thumbnail (if not using default img) */
  children?: React.ReactNode
}

/**
 * Displays an image thumbnail that opens in a full-size lightbox modal when clicked
 */
export function ImageLightbox({
  src,
  alt,
  thumbnailClassName,
  className,
  children,
}: ImageLightboxProps) {
  const [isOpen, setIsOpen] = useState(false)

  const handleOpen = useCallback(() => {
    setIsOpen(true)
  }, [])

  const assetSrc = convertFileSrc(src)

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={`cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-md ${className ?? ''}`}
      >
        {children ?? (
          <img src={assetSrc} alt={alt} className={thumbnailClassName} />
        )}
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm"
          showCloseButton={true}
        >
          <VisuallyHidden>
            <DialogTitle>Image Preview</DialogTitle>
            <DialogDescription>Preview of image: {alt}</DialogDescription>
          </VisuallyHidden>
          <img
            src={assetSrc}
            alt={alt}
            className="max-w-full max-h-[calc(85vh-4rem)] object-contain rounded-md mx-auto"
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
