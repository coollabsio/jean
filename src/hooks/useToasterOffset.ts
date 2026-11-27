import { useSyncExternalStore } from 'react'
import { useUIStore } from '@/store/ui-store'
import { isNativeApp } from '@/lib/environment'
import { isMobileViewport } from '@/lib/viewport'
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
  // The native browser webview paints over DOM toasts, so keep toasts clear
  // of the right panel while it shows the Browser tab.
  const browserPanelWidth = useUIStore(s =>
    s.fileBrowserVisible && s.rightPanelTab === 'browser' && !isMobileViewport()
      ? s.fileBrowserSize
      : 0
  )
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

  const right = BASE + (browserPanelWidth > 0 ? browserPanelWidth + GUTTER : 0)
  const bottom = BASE

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
