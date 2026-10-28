import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { AgentQuestionCard } from './AgentQuestionCard'
import type { AgentQuestion } from './agent-messages'

const single: AgentQuestion = {
  question: 'Where should the session run?',
  options: ['New worktree', 'Existing session'],
  multiple: false,
}
const multiple: AgentQuestion = { ...single, multiple: true }

describe('AgentQuestionCard', () => {
  it('sends a single-choice option on click, without an Answer button', () => {
    const onSend = vi.fn()
    render(
      <AgentQuestionCard
        id="q1"
        question={single}
        answer={undefined}
        disabled={false}
        onSend={onSend}
      />
    )
    expect(
      screen.queryByRole('button', { name: /Answer/ })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Existing session' }))
    expect(onSend).toHaveBeenCalledWith('Existing session')
  })

  it('sends the picked options of a multiple-choice question with Answer', () => {
    const onSend = vi.fn()
    render(
      <AgentQuestionCard
        id="q1"
        question={multiple}
        answer={undefined}
        disabled={false}
        onSend={onSend}
      />
    )
    const answer = screen.getByRole('button', { name: /Answer/ })
    fireEvent.click(answer)
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Existing session' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'New worktree' }))
    fireEvent.click(answer)
    expect(onSend).toHaveBeenCalledWith('- New worktree\n- Existing session')
  })

  it('shows the picked options once answered', () => {
    render(
      <AgentQuestionCard
        id="q1"
        question={multiple}
        answer={'- New worktree\n- Existing session'}
        disabled={false}
        onSend={vi.fn()}
      />
    )
    expect(
      screen.getByText('New worktree, Existing session')
    ).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('shows a typed answer as a custom answer', () => {
    render(
      <AgentQuestionCard
        id="q1"
        question={single}
        answer="Somewhere else"
        disabled={false}
        onSend={vi.fn()}
      />
    )
    expect(screen.getByText('"Somewhere else"')).toBeInTheDocument()
  })
})
