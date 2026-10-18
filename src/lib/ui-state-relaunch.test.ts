import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushUIStateBeforeRelaunch,
  registerUIStateRelaunchSaver,
  relaunchAfterUIStateSave,
} from './ui-state-relaunch'

describe('UI state persistence before relaunch', () => {
  beforeEach(() => {
    registerUIStateRelaunchSaver(null)
  })

  it('waits for the latest UI state to save before it relaunches', async () => {
    const order: string[] = []
    let finishSave: (() => void) | undefined
    registerUIStateRelaunchSaver(
      () =>
        new Promise<void>(resolve => {
          order.push('save-started')
          finishSave = () => {
            order.push('save-finished')
            resolve()
          }
        })
    )
    const relaunch = vi.fn(() => {
      order.push('relaunched')
      return Promise.resolve()
    })

    const pending = relaunchAfterUIStateSave(relaunch)
    await Promise.resolve()

    expect(relaunch).not.toHaveBeenCalled()
    finishSave?.()
    await pending

    expect(order).toEqual(['save-started', 'save-finished', 'relaunched'])
  })

  it('does not block relaunch when persistence is not mounted', async () => {
    const relaunch = vi.fn().mockResolvedValue(undefined)

    await flushUIStateBeforeRelaunch()
    await relaunchAfterUIStateSave(relaunch)

    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('still relaunches when the UI state save fails', async () => {
    registerUIStateRelaunchSaver(() => Promise.reject(new Error('save failed')))
    const relaunch = vi.fn().mockResolvedValue(undefined)

    await expect(relaunchAfterUIStateSave(relaunch)).rejects.toThrow(
      'save failed'
    )

    expect(relaunch).toHaveBeenCalledOnce()
  })
})
