import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { ReviewMethodModal } from './ReviewMethodModal'

vi.mock('@/services/coderabbit-cli', () => ({
  useCodeRabbitCliStatus: () => ({
    data: { installed: true, path: '/usr/local/bin/coderabbit' },
    isLoading: false,
  }),
}))

const environment = vi.hoisted(() => ({ native: false, mobile: false }))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => environment.native,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => environment.mobile,
}))

const noop = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  environment.native = false
  environment.mobile = false
})

describe('ReviewMethodModal', () => {
  it('shows option descriptions without truncation', () => {
    render(
      <ReviewMethodModal
        open
        onOpenChange={noop}
        onAiReview={noop}
        onCodeRabbitCliReview={noop}
        onCodeRabbitPrReview={noop}
        codeRabbitPrAvailable
      />
    )

    const jeanDescription = screen.getByText(
      'Reviews your current branch against its base, including uncommitted changes'
    )
    const codeRabbitDescription = screen.getByText(
      'Trigger via CLI or PR comment'
    )

    expect(jeanDescription).toBeInTheDocument()
    expect(jeanDescription).not.toHaveClass('truncate')
    expect(codeRabbitDescription).toBeInTheDocument()
    expect(codeRabbitDescription).not.toHaveClass('truncate')
  })

  it('does not offer the redundant Final review option', () => {
    render(
      <ReviewMethodModal
        open
        onOpenChange={noop}
        onAiReview={noop}
        onCodeRabbitCliReview={noop}
        onCodeRabbitPrReview={noop}
        codeRabbitPrAvailable
      />
    )

    expect(screen.queryByText('Final review')).not.toBeInTheDocument()
  })

  it('enables numbered shortcuts on native desktop', async () => {
    environment.native = true
    const onCodeRabbitCliReview = vi.fn()
    const user = userEvent.setup()
    render(
      <ReviewMethodModal
        open
        onOpenChange={noop}
        onAiReview={noop}
        onCodeRabbitCliReview={onCodeRabbitCliReview}
        onCodeRabbitPrReview={noop}
        codeRabbitPrAvailable
      />
    )

    expect(screen.getByText('2')).toBeInTheDocument()
    await user.keyboard('2')
    expect(onCodeRabbitCliReview).toHaveBeenCalledOnce()
  })

  it.each([
    ['web', false, false],
    ['mobile', true, true],
  ])(
    'hides and disables numbered shortcuts on %s',
    async (_, native, mobile) => {
      environment.native = native
      environment.mobile = mobile
      const onCodeRabbitCliReview = vi.fn()
      const user = userEvent.setup()
      render(
        <ReviewMethodModal
          open
          onOpenChange={noop}
          onAiReview={noop}
          onCodeRabbitCliReview={onCodeRabbitCliReview}
          onCodeRabbitPrReview={noop}
          codeRabbitPrAvailable
        />
      )

      expect(screen.queryByText('2')).toBeNull()
      await user.keyboard('2')
      expect(onCodeRabbitCliReview).not.toHaveBeenCalled()
    }
  )
})
