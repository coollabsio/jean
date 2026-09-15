import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProjectsOverview } from './RemoteProjectsOverview'

vi.mock('@/services/multi-server-projects', () => ({
  useMultiServerProjects: () => ({
    data: [
      {
        id: 'same',
        key: 'r1:same',
        name: 'Jean',
        serverId: 'r1',
        serverName: 'Build',
        offline: false,
        cachedAt: 1,
      },
      {
        id: 'same',
        key: 'r2:same',
        name: 'Jean',
        serverId: 'r2',
        serverName: 'Lab',
        offline: true,
        cachedAt: 1,
      },
    ],
    isLoading: false,
  }),
}))

describe('RemoteProjectsOverview', () => {
  it('shows duplicate repositories under separate servers and filters them', () => {
    render(<RemoteProjectsOverview />)

    expect(screen.getAllByText('Jean')).toHaveLength(2)
    expect(screen.getByText('Offline')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Build' }))
    expect(screen.getAllByText('Jean')).toHaveLength(1)
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })
})
