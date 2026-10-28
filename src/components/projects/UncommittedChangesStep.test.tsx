import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { CloseWorktreeDialog } from '@/components/chat/CloseWorktreeDialog'
import type { Worktree } from '@/types/projects'
import { DeleteWorktreeDialog } from './DeleteWorktreeDialog'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    branch: 'feature-x',
    session_type: 'worktree',
    cached_uncommitted_added: 0,
    cached_uncommitted_removed: 0,
    ...overrides,
  } as Worktree
}

const dirty = { cached_uncommitted_added: 3, cached_uncommitted_removed: 1 }

describe('CloseWorktreeDialog uncommitted changes', () => {
  it('asks a second time before deleting a worktree with uncommitted changes', () => {
    const onConfirm = vi.fn()
    render(
      <CloseWorktreeDialog
        open
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
        worktree={makeWorktree(dirty)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Delete/ }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText('Discard uncommitted changes?')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Discard and Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('asks a second time when Enter confirms the first step', () => {
    const onConfirm = vi.fn()
    render(
      <CloseWorktreeDialog
        open
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
        worktree={makeWorktree(dirty)}
      />
    )

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText('Discard uncommitted changes?')).toBeTruthy()
  })

  it.each([
    ['a clean worktree', makeWorktree()],
    ['a base session', makeWorktree({ ...dirty, session_type: 'base' })],
  ])('deletes %s after one confirm', (_label, worktree) => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <CloseWorktreeDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        worktree={worktree}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Delete/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not ask a second time when closing a session', () => {
    const onConfirm = vi.fn()
    render(
      <CloseWorktreeDialog
        open
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
        mode="session"
        worktree={makeWorktree(dirty)}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Delete/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('DeleteWorktreeDialog uncommitted changes', () => {
  it('keeps the teardown choice through the second step', () => {
    const onDelete = vi.fn()
    render(
      <DeleteWorktreeDialog
        open
        onOpenChange={() => undefined}
        worktree={makeWorktree(dirty)}
        onDelete={onDelete}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Without Teardown' })
    )
    expect(onDelete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard and Delete' }))
    expect(onDelete).toHaveBeenCalledWith(true)
  })

  it('deletes a clean worktree after one confirm', () => {
    const onDelete = vi.fn()
    render(
      <DeleteWorktreeDialog
        open
        onOpenChange={() => undefined}
        worktree={makeWorktree()}
        onDelete={onDelete}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Delete↵?$/ }))
    expect(onDelete).toHaveBeenCalledWith(false)
  })
})
