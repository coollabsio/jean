import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UsageModeStep } from './UsageModeStep'

describe('UsageModeStep', () => {
  it('defaults to local and reports the selected mode', () => {
    const onSelect = vi.fn()
    render(<UsageModeStep onSelect={onSelect} />)

    expect(screen.getByText('How will you use Jean?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Local/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remote/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onSelect).toHaveBeenCalledWith('local')
  })

  it('selects remote when the remote card is chosen', () => {
    const onSelect = vi.fn()
    render(<UsageModeStep onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /Remote/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onSelect).toHaveBeenCalledWith('remote')
  })
})
