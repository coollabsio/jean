import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlaneSettingsForm } from './PlaneSettingsForm'

const saved = { apiKey: '', workspaceSlug: 'acme', baseUrl: '' }

function renderForm(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(<PlaneSettingsForm saved={saved} isSaving={false} onSave={onSave} />)
  return onSave
}

describe('PlaneSettingsForm', () => {
  it('saves only changed fields so a redacted API key is not cleared', async () => {
    const onSave = renderForm()

    fireEvent.change(screen.getByLabelText('Plane workspace slug'), {
      target: { value: '  other-ws ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ workspaceSlug: 'other-ws' })
    )
  })

  it('rejects a base URL that is not http or https', () => {
    const onSave = renderForm()

    fireEvent.change(screen.getByLabelText('Plane base URL'), {
      target: { value: 'ftp://plane.example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).not.toHaveBeenCalled()
  })
})
