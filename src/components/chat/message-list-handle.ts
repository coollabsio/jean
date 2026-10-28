/** Imperative handle of the chat message list (CompactMessageList). */
export interface MessageListHandle {
  /** Scroll to a specific message by index */
  scrollToIndex: (
    index: number,
    options?: { align?: 'start' | 'center' | 'end' }
  ) => void
  /** Check if a message index is currently in the visible range */
  isIndexInView: (index: number) => boolean
  /** Get the current visible range */
  getVisibleRange: () => { start: number; end: number } | null
}
