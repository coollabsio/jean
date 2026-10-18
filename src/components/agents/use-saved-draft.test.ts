import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { sameJeanTools } from './agent-connectors'
import { useSavedDraft } from './use-saved-draft'

function setup(initial: string[] | null) {
  return renderHook(
    ({ saved }: { saved: string[] | null }) =>
      useSavedDraft(saved, sameJeanTools),
    { initialProps: { saved: initial } }
  )
}

describe('useSavedDraft', () => {
  it('lets the user return to the old value after a save', () => {
    const hook = setup(null)
    act(() => hook.result.current[1](['notify_user']))
    hook.rerender({ saved: ['notify_user'] })
    act(() => hook.result.current[1](null))
    expect(hook.result.current[0]).toBeNull()
  })

  it('follows a remote change after a local save', () => {
    const hook = setup(null)
    act(() => hook.result.current[1](['notify_user']))
    hook.rerender({ saved: ['notify_user'] })
    hook.rerender({ saved: ['task_list'] })
    expect(hook.result.current[0]).toEqual(['task_list'])
  })

  it('keeps local edits when the saved value changes', () => {
    const hook = setup(null)
    act(() => hook.result.current[1](['notify_user']))
    hook.rerender({ saved: ['task_list'] })
    expect(hook.result.current[0]).toEqual(['notify_user'])
  })
})
