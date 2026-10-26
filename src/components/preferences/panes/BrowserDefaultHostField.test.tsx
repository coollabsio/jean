import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { toast } from 'sonner'
import { BrowserDefaultHostField } from './BrowserDefaultHostField'
import type { AppPreferences } from '@/types/preferences'

const mutate = vi.hoisted(() => vi.fn())

vi.mock('@/services/preferences', () => ({
  usePatchPreferences: () => ({
    mutate,
    isPending: false,
    variables: undefined,
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const preferences = {
  browser_default_host: 'dev.example.com',
} as AppPreferences

describe('BrowserDefaultHostField', () => {
  beforeEach(() => {
    mutate.mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it('saves a canonical hostname on this server', async () => {
    const user = userEvent.setup()
    render(<BrowserDefaultHostField preferences={preferences} />)

    const input = screen.getByLabelText('Default preview hostname')
    expect(input).toHaveValue('dev.example.com')

    await user.clear(input)
    await user.type(input, 'Preview.Example.COM')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutate).toHaveBeenCalledWith({
      browser_default_host: 'preview.example.com',
    })
  })

  it('clears the setting when the field is blank', async () => {
    const user = userEvent.setup()
    render(<BrowserDefaultHostField preferences={preferences} />)

    await user.clear(screen.getByLabelText('Default preview hostname'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutate).toHaveBeenCalledWith({ browser_default_host: null })
  })

  it('rejects a scheme or port and keeps the saved hostname', async () => {
    const user = userEvent.setup()
    render(<BrowserDefaultHostField preferences={preferences} />)

    const input = screen.getByLabelText('Default preview hostname')
    await user.clear(input)
    await user.type(input, 'http://dev.example.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutate).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
    expect(input).toHaveValue('http://dev.example.com')
  })
})
