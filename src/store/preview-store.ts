import type { ReactElement } from 'react'
import { create } from 'zustand'

interface PreviewState {
  /** Dialog content of the open attachment/image preview. */
  preview: ReactElement | null
  open: boolean
  /** Increments on each open so a new preview never reuses the old state. */
  openCount: number
  openPreview: (preview: ReactElement) => void
  closePreview: () => void
}

/**
 * Attachment and image previews render from one host at the app root, not
 * inside the chat message that opened them. Chat rows remount when new
 * messages arrive, and a dialog owned by the row closed with it.
 */
export const usePreviewStore = create<PreviewState>()(set => ({
  preview: null,
  open: false,
  openCount: 0,
  openPreview: preview =>
    set(state => ({ preview, open: true, openCount: state.openCount + 1 })),
  // Keep `preview` so the close animation still has content to show.
  closePreview: () => set(state => (state.open ? { open: false } : state)),
}))
