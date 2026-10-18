/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { MainWindowContent } from './MainWindowContent'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: [] }),
}))

vi.mock('@/components/agents/agents-feature', () => ({
  useShowAgents: () => false,
  useAgentsEnabled: () => false,
  useAgentsEnabledServers: () => [],
}))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['claude'],
    isLoading: false,
  }),
}))

vi.mock('@/lib/idle', () => ({
  scheduleIdleWork: (fn: () => void) => {
    fn()
    return () => undefined
  },
}))

vi.mock('@/components/chat/ChatWindow', () => ({
  ChatWindow: () => <div data-testid="chat-window">Chat</div>,
}))

vi.mock('@/components/dashboard/ProjectCanvasView', () => ({
  ProjectCanvasView: () => (
    <div data-testid="project-canvas">Project canvas</div>
  ),
}))

function fireTouch(
  el: Element,
  type: 'touchstart' | 'touchmove' | 'touchend',
  clientX: number,
  clientY = 100
) {
  const touch = {
    clientX,
    clientY,
    identifier: 0,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
    target: el,
  } as unknown as Touch

  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' ? [] : [touch],
    targetTouches: type === 'touchend' ? [] : [touch],
    changedTouches: [touch],
  })
  el.dispatchEvent(event)
}

describe('MainWindowContent mobile swipe open sidebar', () => {
  beforeEach(() => {
    useUIStore.setState({
      leftSidebarVisible: false,
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    })
    useChatStore.setState({
      activeWorktreePath: null,
      activeWorktreeId: null,
    })
    useProjectsStore.setState({ selectedProjectId: 'proj-1' })
  })

  it('keeps the canvas stationary while the sidebar overlay owns the swipe', async () => {
    const swipeContainerRef = createRef<HTMLDivElement>()
    render(<MainWindowContent sidebarSwipeContainerRef={swipeContainerRef} />)

    const target = await screen.findByTestId('mobile-swipe-open-sidebar')
    expect(swipeContainerRef.current).toBe(target)

    act(() => {
      fireTouch(target, 'touchstart', 8)
      fireTouch(target, 'touchmove', 120)
    })

    expect(target).not.toHaveStyle({ transform: 'translateX(112px)' })
    expect(screen.queryByTestId('mobile-swipe-sidebar-underlay')).toBeNull()
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })

  it('shows the circular indicator at the current swipe position', () => {
    render(
      <MainWindowContent
        sidebarSwipeIndicator={{
          isSwiping: true,
          translateX: 68,
          progress: 0.5,
        }}
      />
    )

    const indicator = screen.getByTestId('mobile-sidebar-swipe-indicator')
    expect(indicator).toHaveStyle({ left: '60px' })
    expect(indicator.firstElementChild).toHaveStyle({
      width: '20px',
      height: '20px',
    })
    expect(
      Number((indicator.firstElementChild as HTMLElement).style.opacity)
    ).toBeCloseTo(0.65)
  })

  it('attaches the sidebar swipe target inside chat without leaving it', async () => {
    useChatStore.setState({
      activeWorktreePath: '/tmp/wt',
      activeWorktreeId: 'wt-1',
    })

    const swipeContainerRef = createRef<HTMLDivElement>()
    render(<MainWindowContent sidebarSwipeContainerRef={swipeContainerRef} />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-window')).toBeInTheDocument()
    })
    const target = screen.getByTestId('mobile-swipe-chat')
    expect(swipeContainerRef.current).toBe(target)
    expect(screen.queryByTestId('mobile-swipe-open-sidebar')).toBeNull()
  })
})

describe('MainWindowContent mobile chat gestures', () => {
  beforeEach(() => {
    useUIStore.setState({
      leftSidebarVisible: false,
      fileBrowserVisible: false,
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    })
    useChatStore.setState({
      activeWorktreePath: '/tmp/wt',
      activeWorktreeId: 'wt-1',
    })
    useProjectsStore.setState({ selectedProjectId: 'proj-1' })
  })

  it('does not expose a right-edge file-browser swipe target', async () => {
    render(<MainWindowContent />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-window')).toBeInTheDocument()
    })
    expect(
      screen.queryByTestId('mobile-swipe-open-file-browser')
    ).not.toBeInTheDocument()
    expect(useUIStore.getState().fileBrowserVisible).toBe(false)
  })
})
