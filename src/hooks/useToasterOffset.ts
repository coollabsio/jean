import { useSyncExternalStore } from 'react'
import { useBrowserStore } from '@/store/browser-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { isNativeApp } from '@/lib/environment'
import {
  getChatComposerBottomOffset,
  subscribeChatComposerMetrics,
} from '@/lib/chat-composer-metrics'

const BASE = 52
const GUTTER = 12

export type ToasterOffsetValue =
  | number
  | string
  | {
      top?: number | string
      right?: number | string
      bottom?: number | string
      left?: number | string
    }

export function useChatComposerToasterOffset(): number {
  return useSyncExternalStore(
    subscribeChatComposerMetrics,
    getChatComposerBottomOffset,
    () => 0
  )
}

export function useToasterOffset(): {
  offset: ToasterOffsetValue
  mobileOffset: ToasterOffsetValue
} {
  const activeWorktreeId = useChatStore(s => s.activeWorktreeId)
  const sessionChatModalOpen = useUIStore(s => s.sessionChatModalOpen)
  const sessionChatModalWorktreeId = useUIStore(
    s => s.sessionChatModalWorktreeId
  )
  const selectedWorktreeId = useProjectsStore(s => s.selectedWorktreeId)

  // Match FloatingDock's resolution order so the hook tracks whichever
  // worktree is actually displaying browser surfaces.
  const currentWorktreeId = sessionChatModalOpen
    ? (sessionChatModalWorktreeId ?? activeWorktreeId ?? selectedWorktreeId)
    : (activeWorktreeId ?? selectedWorktreeId)

  const sidePaneOpen = useBrowserStore(s =>
    currentWorktreeId ? (s.sidePaneOpen[currentWorktreeId] ?? false) : false
  )
  const bottomPanelOpen = useBrowserStore(s =>
    currentWorktreeId ? (s.bottomPanelOpen[currentWorktreeId] ?? false) : false
  )
  const modalOpen = useBrowserStore(s =>
    currentWorktreeId ? (s.modalOpen[currentWorktreeId] ?? false) : false
  )
  const sidePaneWidth = useBrowserStore(s => s.sidePaneWidth)
  const bottomPanelHeight = useBrowserStore(s => s.bottomPanelHeight)
  const modalDockMode = useBrowserStore(s => s.modalDockMode)
  const modalWidth = useBrowserStore(s => s.modalWidth)
  const modalHeight = useBrowserStore(s => s.modalHeight)
  const composerBottom = useChatComposerToasterOffset()

  const mobileBottom = composerBottom > 0 ? composerBottom : BASE

  if (!isNativeApp()) {
    return {
      offset: `${BASE}px`,
      mobileOffset: {
        top: BASE,
        right: BASE,
        left: BASE,
        bottom: mobileBottom,
      },
    }
  }

  let right = BASE
  let bottom = BASE

  if (sidePaneOpen) right += sidePaneWidth + GUTTER
  if (bottomPanelOpen) bottom += bottomPanelHeight + GUTTER

  if (modalOpen) {
    if (modalDockMode === 'right' || modalDockMode === 'floating') {
      right += modalWidth + GUTTER
    } else if (modalDockMode === 'bottom') {
      bottom += modalHeight + GUTTER
    }
  }

  return {
    offset: { top: BASE, right, bottom, left: BASE },
    mobileOffset: {
      top: BASE,
      right,
      left: BASE,
      bottom: mobileBottom,
    },
  }
}
