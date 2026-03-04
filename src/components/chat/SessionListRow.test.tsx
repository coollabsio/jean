import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { SessionCardData } from './session-card-utils'
import { SessionListRow } from './SessionListRow'

const createCard = (): SessionCardData => ({
  session: {
    id: 'session-1',
    name: 'Session 1',
    order: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    messages: [],
    backend: 'claude',
  },
  status: 'idle',
  executionMode: 'plan',
  isSending: false,
  isWaiting: false,
  hasExitPlanMode: false,
  hasQuestion: false,
  hasPermissionDenials: false,
  permissionDenialCount: 0,
  planFilePath: null,
  planContent: null,
  pendingPlanMessageId: null,
  hasRecap: false,
  recapDigest: null,
  label: null,
})

describe('SessionListRow context menu export session', () => {
  it('renders Export Session menu item when export handlers are provided', async () => {
    const user = userEvent.setup()

    render(
      <SessionListRow
        card={createCard()}
        isSelected={false}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onPlanView={vi.fn()}
        onRecapView={vi.fn()}
        onExportClipboard={vi.fn().mockResolvedValue(undefined)}
        onExportFile={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await user.pointer({
      target: screen.getByRole('button', { name: 'Session 1' }),
      keys: '[MouseRight]',
    })

    expect(await screen.findByText('Export Session')).toBeInTheDocument()
  })
})
