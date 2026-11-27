import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@/test/test-utils'
import { InlineQuestionOptions } from './InlineQuestionOptions'

describe('InlineQuestionOptions', () => {
  it('sends one single-choice answer on click', () => {
    const onSend = vi.fn()
    render(
      <InlineQuestionOptions
        questions={[{ question: 'Q?', options: ['A', 'B'], multiple: false }]}
        disabled={false}
        onSend={onSend}
      />
    )
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /B/ }))
    expect(onSend).toHaveBeenCalledWith('2. B')
  })

  it('sends all answers with Accept', () => {
    const onSend = vi.fn()
    render(
      <InlineQuestionOptions
        questions={[
          { question: 'Mode?', options: ['Hash', 'Full'], multiple: false },
          {
            question: 'Timeouts?',
            options: ['Local', 'Remote'],
            multiple: true,
          },
        ]}
        disabled={false}
        onSend={onSend}
      />
    )
    const accept = screen.getByRole('button', { name: 'Accept' })
    const mode = screen.getByRole('group', { name: 'Mode?' })
    const timeouts = screen.getByRole('group', { name: /Timeouts\?/ })
    const option = (group: HTMLElement, name: string) =>
      Array.from(group.querySelectorAll('button')).find(b =>
        b.textContent?.includes(name)
      ) as HTMLElement

    expect(accept).toBeDisabled()
    fireEvent.click(option(mode, 'Hash'))
    fireEvent.click(option(mode, 'Full'))
    fireEvent.click(option(timeouts, 'Remote'))
    fireEvent.click(option(timeouts, 'Local'))
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(accept)
    expect(onSend).toHaveBeenCalledWith(
      'Mode?\n2. Full\n\nTimeouts?\n1. Local\n2. Remote'
    )
  })

  it('clears a single-choice pick on a second click', () => {
    const onSend = vi.fn()
    render(
      <InlineQuestionOptions
        questions={[
          { question: 'Mode?', options: ['Hash', 'Full'], multiple: false },
          { question: 'Scope?', options: ['All', 'Some'], multiple: false },
        ]}
        disabled={false}
        onSend={onSend}
      />
    )
    const accept = screen.getByRole('button', { name: 'Accept' })
    const mode = screen.getByRole('group', { name: 'Mode?' })
    const scope = screen.getByRole('group', { name: 'Scope?' })
    const hash = Array.from(mode.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Hash')
    ) as HTMLElement
    const all = Array.from(scope.querySelectorAll('button')).find(b =>
      b.textContent?.includes('All')
    ) as HTMLElement

    fireEvent.click(all)
    fireEvent.click(hash)
    expect(hash).toHaveAttribute('aria-pressed', 'true')
    expect(accept).toBeEnabled()
    fireEvent.click(hash)
    expect(hash).toHaveAttribute('aria-pressed', 'false')
    // Scope still has a pick
    expect(accept).toBeEnabled()
    fireEvent.click(all)
    expect(accept).toBeDisabled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('sends one answered question and marks the other as not answered', () => {
    const onSend = vi.fn()
    render(
      <InlineQuestionOptions
        questions={[
          { question: 'Mode?', options: ['Hash', 'Full'], multiple: false },
          {
            question: 'Timeouts?',
            options: ['Local', 'Remote'],
            multiple: true,
          },
        ]}
        disabled={false}
        onSend={onSend}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Full/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(onSend).toHaveBeenCalledWith(
      'Mode?\n2. Full\n\nTimeouts?\nNo answer'
    )
  })
})
