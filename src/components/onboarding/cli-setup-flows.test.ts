import { describe, expect, it, vi } from 'vitest'
import { queuePatch } from './cli-setup-flows'

vi.mock('@/services/preferences', () => ({}))

describe('queuePatch', () => {
  it('runs preference patches one at a time, even after a failure', async () => {
    const events: string[] = []
    let releaseFirst: () => void = () => undefined

    const first = queuePatch(
      () =>
        new Promise<void>((_, reject) => {
          events.push('first:start')
          releaseFirst = () => {
            events.push('first:end')
            reject(new Error('revision conflict'))
          }
        })
    )
    const second = queuePatch(async () => {
      events.push('second:start')
    })

    await vi.waitFor(() => expect(events).toEqual(['first:start']))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await expect(first).rejects.toThrow('revision conflict')
    await second
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })
})
