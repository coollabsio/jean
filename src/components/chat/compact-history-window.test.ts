import { describe, expect, it } from 'vitest'
import {
  getCurrentPromptStartIndex,
  remapIndexForWindow,
} from './compact-history-window'

const user = { role: 'user' as const }
const assistant = { role: 'assistant' as const }

describe('getCurrentPromptStartIndex', () => {
  it('returns 0 for empty message lists', () => {
    expect(getCurrentPromptStartIndex([])).toBe(0)
  })

  it('starts at the only user prompt when the current run has no answer yet', () => {
    expect(getCurrentPromptStartIndex([user])).toBe(0)
  })

  it('starts at the latest user prompt', () => {
    expect(
      getCurrentPromptStartIndex([user, assistant, user, assistant, user])
    ).toBe(4)
  })

  it('keeps the latest assistant visible when no user prompt exists', () => {
    expect(getCurrentPromptStartIndex([assistant, assistant])).toBe(1)
  })
})

describe('remapIndexForWindow', () => {
  it('hides indices before the compact window', () => {
    expect(remapIndexForWindow(2, 4)).toBe(-1)
  })

  it('remaps visible indices into the sliced message list', () => {
    expect(remapIndexForWindow(5, 4)).toBe(1)
  })
})
