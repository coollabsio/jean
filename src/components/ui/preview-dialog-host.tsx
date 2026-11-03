import { Fragment } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { usePreviewStore } from '@/store/preview-store'

/** Renders the preview opened through `usePreviewStore.openPreview`. */
export function PreviewDialogHost() {
  const preview = usePreviewStore(state => state.preview)
  const open = usePreviewStore(state => state.open)
  const openCount = usePreviewStore(state => state.openCount)

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) usePreviewStore.getState().closePreview()
      }}
    >
      <Fragment key={openCount}>{preview}</Fragment>
    </Dialog>
  )
}
