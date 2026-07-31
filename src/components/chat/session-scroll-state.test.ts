import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetSessionScrollStateForTests,
  clearSessionScrollState,
  getDefaultVisibleCount,
  getSessionScrollState,
  saveSessionScrollState,
  updateSessionScrollState,
} from './session-scroll-state'

describe('session-scroll-state', () => {
  afterEach(() => {
    __resetSessionScrollStateForTests()
  })

  it('saves and returns a snapshot per session', () => {
    saveSessionScrollState('s1', {
      scrollTop: 420,
      isFollowingTail: false,
      visibleCount: 40,
    })

    expect(getSessionScrollState('s1')).toEqual({
      scrollTop: 420,
      isFollowingTail: false,
      visibleCount: 40,
    })
    expect(getSessionScrollState('s2')).toBeUndefined()
  })

  it('merges partial updates without wiping other fields', () => {
    saveSessionScrollState('s1', {
      scrollTop: 100,
      isFollowingTail: false,
      visibleCount: 30,
    })

    updateSessionScrollState('s1', { scrollTop: 250 })
    expect(getSessionScrollState('s1')).toEqual({
      scrollTop: 250,
      isFollowingTail: false,
      visibleCount: 30,
    })

    updateSessionScrollState('s1', { isFollowingTail: true })
    expect(getSessionScrollState('s1')).toEqual({
      scrollTop: 250,
      isFollowingTail: true,
      visibleCount: 30,
    })
  })

  it('clamps negative scrollTop and enforces minimum visibleCount', () => {
    saveSessionScrollState('s1', {
      scrollTop: -10,
      isFollowingTail: true,
      visibleCount: 2,
    })

    expect(getSessionScrollState('s1')).toEqual({
      scrollTop: 0,
      isFollowingTail: true,
      visibleCount: getDefaultVisibleCount(),
    })
  })

  it('clears a single session snapshot', () => {
    saveSessionScrollState('s1', {
      scrollTop: 1,
      isFollowingTail: false,
      visibleCount: 20,
    })
    saveSessionScrollState('s2', {
      scrollTop: 2,
      isFollowingTail: true,
      visibleCount: 20,
    })

    clearSessionScrollState('s1')
    expect(getSessionScrollState('s1')).toBeUndefined()
    expect(getSessionScrollState('s2')?.scrollTop).toBe(2)
  })

  it('ignores empty session ids', () => {
    saveSessionScrollState('', {
      scrollTop: 99,
      isFollowingTail: false,
      visibleCount: 20,
    })
    expect(getSessionScrollState('')).toBeUndefined()
  })
})
