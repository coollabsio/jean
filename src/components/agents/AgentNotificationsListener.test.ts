import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { isCoordinatorChatInView } from './AgentNotificationsListener'

describe('isCoordinatorChatInView', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useUIStore.setState({
      coordinatorViewOpen: false,
      sessionChatModalOpen: false,
    })
    useProjectsStore.setState({ selectedProjectId: null })
  })

  const showCoordinator = (projectId: string) => {
    useProjectsStore.setState({ selectedProjectId: projectId })
    useUIStore.setState({
      coordinatorViewOpen: true,
      sessionChatModalOpen: false,
    })
  }

  it('is true only for the open coordinator chat of a focused window', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    showCoordinator('p1')
    expect(isCoordinatorChatInView('coord_p1')).toBe(true)
    expect(isCoordinatorChatInView('coord_p2')).toBe(false)
    expect(isCoordinatorChatInView('jean')).toBe(false)
  })

  it('is false when a session modal covers it, it is closed, or the window is in the background', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    showCoordinator('p1')
    useUIStore.setState({ sessionChatModalOpen: true })
    expect(isCoordinatorChatInView('coord_p1')).toBe(false)

    showCoordinator('p1')
    useUIStore.setState({ coordinatorViewOpen: false })
    expect(isCoordinatorChatInView('coord_p1')).toBe(false)

    showCoordinator('p1')
    focus.mockReturnValue(false)
    expect(isCoordinatorChatInView('coord_p1')).toBe(false)
  })
})
