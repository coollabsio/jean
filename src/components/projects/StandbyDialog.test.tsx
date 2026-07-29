import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { StandbyDialog, getStandbyWakeUpOptions } from './StandbyDialog'
import type { Worktree } from '@/types/projects'

const worktree: Worktree = {
  id: 'wt-1',
  project_id: 'project-1',
  name: 'validation-facturation',
  path: '/tmp/project/validation-facturation',
  branch: 'validation-facturation',
  created_at: 1_800_000_000,
  order: 0,
}

describe('getStandbyWakeUpOptions', () => {
  it('propose des échéances simples et futures', () => {
    const now = new Date('2027-01-05T14:00:00.345')
    const options = getStandbyWakeUpOptions(now)

    expect(options.map(option => option.label)).toEqual([
      'Demain à 9 h',
      'Vendredi à 9 h',
      'Lundi prochain à 9 h',
      'Dans une semaine',
    ])
    expect(
      options.every(option => option.timestamp > now.getTime() / 1000)
    ).toBe(true)
    expect(options.every(option => Number.isInteger(option.timestamp))).toBe(
      true
    )
  })
})

describe('StandbyDialog', () => {
  it('exige une raison et transmet la raison avec la date de réveil', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    const tomorrow = getStandbyWakeUpOptions()[0]?.timestamp

    render(
      <StandbyDialog
        open
        worktree={worktree}
        isPending={false}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    const submit = screen.getByRole('button', {
      name: 'Mettre en standby',
    })
    expect(submit).toBeDisabled()

    await user.type(
      screen.getByLabelText('Qu’est-ce que tu attends ?'),
      'Validation de Sarah'
    )
    await user.click(submit)

    expect(onConfirm).toHaveBeenCalledWith('Validation de Sarah', tomorrow)
  })
})
