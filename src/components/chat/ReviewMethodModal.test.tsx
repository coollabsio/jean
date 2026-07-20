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
        onFinalReview={noop}
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

  it('shows Final review immediately after Jean', () => {
    render(
      <ReviewMethodModal
        open
        onOpenChange={noop}
        onAiReview={noop}
        onFinalReview={noop}
        onCodeRabbitCliReview={noop}
        onCodeRabbitPrReview={noop}
        codeRabbitPrAvailable
      />
    )

    const choices = screen.getAllByRole('button')
    const jeanIndex = choices.findIndex(choice =>
      choice.textContent?.includes('Jean review')
    )
    const finalReviewIndex = choices.findIndex(choice =>
      choice.textContent?.includes('Final review')
    )

    expect(finalReviewIndex).toBe(jeanIndex + 1)
    expect(
      screen.getByText('Read-only merge-readiness audit in a new session')
    ).toBeInTheDocument()
  })

  it('enables numbered shortcuts on native desktop', async () => {
    environment.native = true
    const onFinalReview = vi.fn()
    const user = userEvent.setup()
    render(
      <ReviewMethodModal
        open
        onOpenChange={noop}
        onAiReview={noop}
        onFinalReview={onFinalReview}
        onCodeRabbitCliReview={noop}
        onCodeRabbitPrReview={noop}
        codeRabbitPrAvailable
      />
    )

    expect(screen.getByText('2')).toBeInTheDocument()
    await user.keyboard('2')
    expect(onFinalReview).toHaveBeenCalledOnce()
  })

  it.each([
    ['web', false, false],
    ['mobile', true, true],
  ])(
    'hides and disables numbered shortcuts on %s',
    async (_, native, mobile) => {
      environment.native = native
      environment.mobile = mobile
      const onFinalReview = vi.fn()
      const user = userEvent.setup()
      render(
        <ReviewMethodModal
          open
          onOpenChange={noop}
          onAiReview={noop}
          onFinalReview={onFinalReview}
          onCodeRabbitCliReview={noop}
          onCodeRabbitPrReview={noop}
          codeRabbitPrAvailable
        />
      )

      expect(screen.queryByText('2')).toBeNull()
      await user.keyboard('2')
      expect(onFinalReview).not.toHaveBeenCalled()
    }
  )
})
