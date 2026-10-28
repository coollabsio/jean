import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useCreateWorktreeKeybinding } from './projects'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

describe('useCreateWorktreeKeybinding', () => {
  afterEach(() => {
    useProjectsStore.setState({ selectedProjectId: null })
    useUIStore.getState().setNewWorktreeModalOpen(false)
    vi.restoreAllMocks()
  })

  it('does not open the modal when no project is selected', () => {
    const info = vi.spyOn(toast, 'info').mockImplementation(() => 1)
    useProjectsStore.setState({ selectedProjectId: null })
    renderHook(() => useCreateWorktreeKeybinding())

    window.dispatchEvent(new CustomEvent('create-new-worktree'))

    expect(useUIStore.getState().newWorktreeModalOpen).toBe(false)
    expect(info).toHaveBeenCalledWith('Select a project first')
  })

  it('opens the modal when a project is selected', () => {
    useProjectsStore.setState({ selectedProjectId: 'project-1' })
    renderHook(() => useCreateWorktreeKeybinding())

    window.dispatchEvent(new CustomEvent('create-new-worktree'))

    expect(useUIStore.getState().newWorktreeModalOpen).toBe(true)
  })
})
