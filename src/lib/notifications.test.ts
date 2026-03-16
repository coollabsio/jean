import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import {
  notify,
  notifications,
  success,
  error,
  info,
  warning,
} from './notifications'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('./logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

describe('notify', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('toast notifications', () => {
    it('shows info toast by default', async () => {
      await notify('Test Title')

      expect(toast.info).toHaveBeenCalledWith('Test Title', {})
    })

    it('shows info toast with message', async () => {
      await notify('Title', 'Message body')

      expect(toast.info).toHaveBeenCalledWith('Title: Message body', {})
    })

    it('shows success toast', async () => {
      await notify('Success', 'Done!', { type: 'success' })

      expect(toast.success).toHaveBeenCalledWith('Success: Done!', {})
    })

    it('shows error toast', async () => {
      await notify('Error', 'Something failed', { type: 'error' })

      expect(toast.error).toHaveBeenCalledWith('Error: Something failed', {})
    })

    it('shows warning toast', async () => {
      await notify('Warning', 'Be careful', { type: 'warning' })

      expect(toast.warning).toHaveBeenCalledWith('Warning: Be careful', {})
    })

    it('respects custom duration', async () => {
      await notify('Test', undefined, { duration: 5000 })

      expect(toast.info).toHaveBeenCalledWith('Test', { duration: 5000 })
    })

    it('handles zero duration (no auto-dismiss)', async () => {
      await notify('Persistent', undefined, { duration: 0 })

      expect(toast.info).toHaveBeenCalledWith('Persistent', { duration: 0 })
    })
  })

  describe('native notifications', () => {
    it('calls invoke for native notification', async () => {
      const { invoke } = await import('@/lib/transport')

      await notify('Native Title', 'Native body', { native: true })

      expect(invoke).toHaveBeenCalledWith('send_native_notification', {
        title: 'Native Title',
        body: 'Native body',
      })
      expect(toast.info).not.toHaveBeenCalled()
    })

    it('falls back to toast on native notification error', async () => {
      const { invoke } = await import('@/lib/transport')
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Native failed'))

      await notify('Title', 'Body', { native: true })

      expect(toast.error).toHaveBeenCalledWith('Title: Body')
    })

    it('falls back to toast with title only on error', async () => {
      const { invoke } = await import('@/lib/transport')
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Failed'))

      await notify('Just Title', undefined, { native: true })

      expect(toast.error).toHaveBeenCalledWith('Just Title')
    })
  })
})

describe('notifications convenience object', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has success method', async () => {
    await notifications.success('Done', 'Completed')
    expect(toast.success).toHaveBeenCalled()
  })

  it('has error method', async () => {
    await notifications.error('Failed', 'Error occurred')
    expect(toast.error).toHaveBeenCalled()
  })

  it('has info method', async () => {
    await notifications.info('Info', 'FYI')
    expect(toast.info).toHaveBeenCalled()
  })

  it('has warning method', async () => {
    await notifications.warning('Caution', 'Watch out')
    expect(toast.warning).toHaveBeenCalled()
  })
})

describe('exported convenience functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('success function works', async () => {
    await success('Title')
    expect(toast.success).toHaveBeenCalled()
  })

  it('error function works', async () => {
    await error('Title')
    expect(toast.error).toHaveBeenCalled()
  })

  it('info function works', async () => {
    await info('Title')
    expect(toast.info).toHaveBeenCalled()
  })

  it('warning function works', async () => {
    await warning('Title')
    expect(toast.warning).toHaveBeenCalled()
  })
})
