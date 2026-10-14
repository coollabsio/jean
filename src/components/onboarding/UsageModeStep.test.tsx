import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UsageModeStep } from './UsageModeStep'

describe('UsageModeStep', () => {
  it('reports local when this computer is picked', () => {
    const onSelect = vi.fn()
    render(<UsageModeStep onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /This computer/i }))
    expect(onSelect).toHaveBeenCalledWith('local')
  })

  it('reports remote when a remote server is picked', () => {
    const onSelect = vi.fn()
    render(<UsageModeStep onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /Remote server/i }))
    expect(onSelect).toHaveBeenCalledWith('remote')
  })
})
