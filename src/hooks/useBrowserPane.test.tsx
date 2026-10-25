import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { DEFAULT_NEW_TAB_URL, useBrowserStore } from '@/store/browser-store'
import {
  openBrowserTabFromNewWindow,
  useBrowserEvents,
  useBrowserTabActions,
} from './useBrowserPane'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invoke: invokeMock,
  listen: listenMock,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => true,
}))

describe('useBrowserTabActions grab integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.className = ''
    invokeMock.mockResolvedValue(undefined)
  })

  it('invokes the native React Grab injection command for the active tab', async () => {
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useBrowserTabActions('tab-1'))

    await result.current.enableGrab()

    expect(invokeMock).toHaveBeenCalledWith('browser_enable_grab', {
      tabId: 'tab-1',
      theme: 'dark',
    })
  })
})

function resetBrowserStore(): void {
  useBrowserStore.setState({
    tabs: {},
    activeTabIds: {},
    sidePaneOpen: {},
    modalOpen: {},
    bottomPanelOpen: {},
  })
}

describe('openBrowserTabFromNewWindow', () => {
  beforeEach(() => {
    resetBrowserStore()
  })

  it('opens an http(s) url as a new tab in the source worktree pane', () => {
    const sourceId = useBrowserStore
      .getState()
      .addTab('worktree-1', 'https://example.com')
    useBrowserStore.getState().addTab('worktree-2', 'https://other.example')
    useBrowserStore.getState().setBottomPanelOpen('worktree-1', true)

    const createdId = openBrowserTabFromNewWindow(
      sourceId,
      'https://example.com/docs'
    )

    const tabs = useBrowserStore.getState().getTabs('worktree-1')
    expect(createdId).toBe(tabs[1]?.id)
    expect(tabs.map(tab => tab.url)).toEqual([
      'https://example.com',
      'https://example.com/docs',
    ])
    expect(useBrowserStore.getState().activeTabIds['worktree-1']).toBe(
      createdId
    )
    expect(useBrowserStore.getState().getTabs('worktree-2')).toHaveLength(1)
    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().sidePaneOpen['worktree-1'] ?? false).toBe(
      false
    )
    expect(useBrowserStore.getState().modalOpen['worktree-1'] ?? false).toBe(
      false
    )
  })

  it('opens a blank tab for an empty new-window url', () => {
    const sourceId = useBrowserStore
      .getState()
      .addTab('worktree-1', 'https://example.com')

    const createdId = openBrowserTabFromNewWindow(sourceId, '   ')

    const tabs = useBrowserStore.getState().getTabs('worktree-1')
    expect(tabs).toHaveLength(2)
    expect(tabs[1]?.id).toBe(createdId)
    expect(tabs[1]?.url).toBe(DEFAULT_NEW_TAB_URL)
  })

  it('ignores an unknown source tab and non-http urls', () => {
    const sourceId = useBrowserStore
      .getState()
      .addTab('worktree-1', 'https://example.com')

    expect(
      openBrowserTabFromNewWindow('missing-tab', 'https://example.com/next')
    ).toBeNull()
    expect(
      openBrowserTabFromNewWindow(sourceId, 'javascript:alert(1)')
    ).toBeNull()
    expect(openBrowserTabFromNewWindow(sourceId, 'file:///tmp/x')).toBeNull()
    expect(useBrowserStore.getState().getTabs('worktree-1')).toHaveLength(1)
  })
})

describe('useBrowserEvents new window', () => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>()

  beforeEach(() => {
    vi.clearAllMocks()
    resetBrowserStore()
    handlers.clear()
    listenMock.mockImplementation(
      async (event: string, handler: (event: { payload: unknown }) => void) => {
        handlers.set(event, handler)
        return () => undefined
      }
    )
  })

  it('creates a Jean tab when browser:new-window fires', () => {
    const sourceId = useBrowserStore
      .getState()
      .addTab('worktree-1', 'https://example.com')
    renderHook(() => useBrowserEvents())

    const handler = handlers.get('browser:new-window')
    expect(handler).toBeTypeOf('function')
    handler?.({
      payload: { tabId: sourceId, url: 'https://example.com/from-blank' },
    })

    expect(
      useBrowserStore
        .getState()
        .getTabs('worktree-1')
        .map(tab => tab.url)
    ).toEqual(['https://example.com', 'https://example.com/from-blank'])
  })
})
