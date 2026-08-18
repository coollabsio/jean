import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorktreeSetupProgress } from './WorktreeSetupProgress'
import type { QueuedMessage } from '@/types/chat'

describe('WorktreeSetupProgress', () => {
  it('shows a calm, actionable setup state without exposing the command by default', () => {
    render(
      <WorktreeSetupProgress
        setupScript="bun install && bun run build"
        queuedMessage={
          {
            id: 'queued-message-1',
            message: 'Fix the checkout regression',
            pendingImages: [
              {
                id: 'image-1',
                path: '/tmp/checkout.png',
                filename: 'checkout.png',
              },
            ],
            pendingFiles: [],
            pendingSkills: [],
            pendingTextFiles: [],
            model: 'claude-sonnet-4-6',
            provider: null,
            executionMode: 'plan',
            thinkingLevel: 'think',
            queuedAt: 1,
          } satisfies QueuedMessage
        }
      />
    )

    expect(screen.getByText('Preparing your workspace')).toBeInTheDocument()
    expect(screen.getByText(/prompt will start automatically/i)).toBeVisible()
    expect(
      screen.getByText('You can leave this view — setup will keep running.')
    ).toBeInTheDocument()
    expect(screen.getByText('Show setup command')).toBeInTheDocument()
    expect(screen.getByText('bun install && bun run build')).not.toBeVisible()
    expect(screen.getByText('Fix the checkout regression')).toBeVisible()
    expect(screen.getByAltText('checkout.png')).toBeVisible()
    expect(screen.getByText('Queued until setup finishes')).toBeVisible()
  })
})
