import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import type { Project } from '@/types/projects'
import { ProjectView } from './ProjectView'

const mocks = vi.hoisted(() => ({ coordinatorEnabled: true }))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { coordinator_enabled: mocks.coordinatorEnabled },
  }),
}))
vi.mock('./ProjectCanvasView', () => ({
  ProjectCanvasView: ({
    headerAccessory,
    embedded,
  }: {
    headerAccessory?: ReactNode
    embedded?: boolean
  }) =>
    embedded ? null : (
      <div>
        sessions canvas
        {headerAccessory}
      </div>
    ),
}))
vi.mock('@/components/agents/CoordinatorView', () => ({
  CoordinatorView: ({ viewSwitch }: { viewSwitch: ReactNode }) => (
    <div>
      coordinator view
      {viewSwitch}
    </div>
  ),
}))

const project = { id: 'p1', name: 'My Project' } as Project

beforeEach(() => {
  mocks.coordinatorEnabled = true
  useUIStore.setState({ projectViewModes: {} })
})

describe('ProjectView', () => {
  it('switches between the coordinator and the full sessions canvas', async () => {
    render(<ProjectView projectId="p1" project={project} />)
    expect(screen.getByText('coordinator view')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Sessions' }))
    expect(screen.getByText('sessions canvas')).toBeVisible()
    expect(screen.queryByText('coordinator view')).toBeNull()
    expect(useUIStore.getState().projectViewModes.p1).toBe('sessions')

    await userEvent.click(screen.getByRole('button', { name: 'Coordinator' }))
    expect(screen.getByText('coordinator view')).toBeVisible()
  })

  it('shows the canvas without the switch when the coordinator is off', () => {
    mocks.coordinatorEnabled = false
    render(<ProjectView projectId="p1" project={project} />)
    expect(screen.getByText('sessions canvas')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Sessions' })).toBeNull()
  })
})
