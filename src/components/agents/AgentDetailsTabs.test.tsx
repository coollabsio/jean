import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import type { AgentDetails, AgentSummary } from '@/services/agents'
import { AgentInbox } from './AgentInbox'
import { AgentMemoryView } from './AgentMemoryView'

const { details, mutation } = vi.hoisted(() => {
  const details: AgentDetails = {
    delegations: [],
    schedules: [],
    approvals: [],
    memories: [],
    journal: [
      {
        id: 1,
        agentId: 'jean',
        projectId: null,
        content: 'Shipped the orbit fix.',
        occurredAt: 1_760_000_000,
        createdAt: 1_760_000_000,
        source: 'user',
        sourceSessionId: null,
      },
    ],
    memoryChanges: [],
    tasks: [],
    notifications: [],
    subagentTypes: [],
    changes: [],
  }
  const mutation = () => ({ mutate: vi.fn(), isPending: false })
  return { details, mutation }
})

vi.mock('@/services/agents', async importOriginal => ({
  ...((await importOriginal()) as object),
  useAgentDetails: () => ({ data: details, isLoading: false }),
  useSearchAgentMemory: () => ({ data: undefined, isLoading: false }),
  useSearchAgentJournal: () => ({ data: undefined, isLoading: false }),
  useSaveAgentMemory: mutation,
  useSaveAgentJournal: mutation,
  useUpdateAgentMemory: mutation,
  useSupersedeAgentMemory: mutation,
  useDeleteAgentMemory: mutation,
  useMarkAgentNotificationsRead: mutation,
}))

const agent = {
  id: 'jean',
  name: 'Jean',
  unreadNotifications: 0,
} as AgentSummary

describe('agent details tabs', () => {
  it('Memory shows titled sections with plain counts and icon add buttons', async () => {
    render(<AgentMemoryView agent={agent} />)

    const facts = screen.getByTestId('user-facts')
    expect(within(facts).getByRole('heading').textContent).toBe('About you0')
    expect(within(facts).getByText('No facts about you yet.')).toBeVisible()
    const journal = screen.getByTestId('journal-timeline')
    expect(within(journal).getAllByRole('heading')[0]?.textContent).toBe(
      'Journal1'
    )
    expect(within(journal).getByText('Shipped the orbit fix.')).toBeVisible()
    expect(within(journal).getByText('You')).toBeVisible()

    await userEvent.click(
      within(facts).getByRole('button', { name: 'Add fact' })
    )
    expect(screen.getByLabelText('Fact about you')).toBeVisible()
    expect(within(facts).getByRole('button', { name: 'Close' })).toBeVisible()
  })

  it('Memory keeps Copy as Markdown in the overflow menu', async () => {
    render(<AgentMemoryView agent={agent} />)

    expect(screen.queryByText('Copy as Markdown')).toBeNull()
    await userEvent.click(
      screen.getByRole('button', { name: 'More memory actions' })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Copy as Markdown' })
    ).toBeVisible()
  })

  it('Inbox shows a one-line empty state without a help icon', () => {
    render(<AgentInbox agent={agent} />)

    expect(screen.getByText('No messages yet.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^About/ })).toBeNull()
  })
})
