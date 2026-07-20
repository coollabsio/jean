import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { BranchItem, SecurityAlertItem } from './NewWorktreeItems'
import type { DependabotAlert } from '@/types/github'

let isMobile = false

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

const alert: DependabotAlert = {
  number: 12,
  state: 'open',
  packageName: 'lodash',
  packageEcosystem: 'npm',
  manifestPath: 'package.json',
  ghsaId: 'GHSA-test-1234',
  severity: 'critical',
  summary: 'Prototype pollution',
  description: 'A test advisory',
  createdAt: '2026-01-01T00:00:00Z',
  htmlUrl: 'https://github.com/example/repo/security/dependabot/12',
}

function renderSecurityAlertItem(overrides = {}) {
  return render(
    <SecurityAlertItem
      alert={alert}
      index={0}
      isSelected={false}
      isCreating={false}
      onMouseEnter={vi.fn()}
      onClick={vi.fn()}
      onInvestigate={vi.fn()}
      onPreview={vi.fn()}
      {...overrides}
    />
  )
}

beforeEach(() => {
  isMobile = false
})

describe('NewWorktreeItems mobile actions', () => {
  it('puts preview, investigate, and background investigation behind a mobile overflow menu', async () => {
    isMobile = true
    const user = userEvent.setup()
    const onPreview = vi.fn()
    const onInvestigate = vi.fn()

    renderSecurityAlertItem({ onPreview, onInvestigate })

    expect(screen.queryByRole('button', { name: /preview alert/i })).toBeNull()
    expect(
      screen.queryByRole('button', { name: /investigate alert/i })
    ).toBeNull()

    await user.click(screen.getByRole('button', { name: /alert actions/i }))
    await user.click(screen.getByRole('menuitem', { name: /preview/i }))
    expect(onPreview).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /alert actions/i }))
    await user.click(screen.getByRole('menuitem', { name: /^investigate$/i }))
    expect(onInvestigate).toHaveBeenLastCalledWith(false)

    await user.click(screen.getByRole('button', { name: /alert actions/i }))
    await user.click(
      screen.getByRole('menuitem', { name: /investigate in background/i })
    )
    expect(onInvestigate).toHaveBeenLastCalledWith(true)
  })
})

describe('BranchItem', () => {
  it('opens the selected branch directly without offering a child branch action', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <BranchItem
        branch="feature/existing"
        index={0}
        isSelected={false}
        isCreating={false}
        onMouseEnter={vi.fn()}
        onClick={onClick}
      />
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'feature/existing' }))
    expect(onClick).toHaveBeenCalledWith(false)
  })
})
