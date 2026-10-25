import { render, screen } from '@/test/test-utils'
import { describe, expect, it } from 'vitest'
import {
  StatusIndicator,
  WorkingWaveform,
} from '@/components/ui/status-indicator'

describe('status indicator tooltips', () => {
  it('uses the shared tooltip trigger instead of a native title', () => {
    render(<StatusIndicator status="waiting" label="Waiting for input" />)
    const dot = screen.getByRole('img', { name: 'Waiting for input' })
    expect(dot).not.toHaveAttribute('title')
    expect(dot).toHaveAttribute('data-slot', 'tooltip-trigger')

    render(<WorkingWaveform label="Working" />)
    const waveform = screen.getByRole('img', { name: 'Working' })
    expect(waveform).not.toHaveAttribute('title')
    expect(waveform).toHaveAttribute('data-slot', 'tooltip-trigger')
  })

  it('leaves unlabeled waveforms without a tooltip', () => {
    const { container } = render(<WorkingWaveform />)
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull()
    expect(container.querySelector('[title]')).toBeNull()
  })
})
