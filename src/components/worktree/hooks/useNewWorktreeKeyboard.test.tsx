import type React from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNewWorktreeKeyboard } from './useNewWorktreeKeyboard'

type Options = Parameters<typeof useNewWorktreeKeyboard>[0]

function pressMod(githubOnlyTabsEnabled: boolean, key: string) {
  const setActiveTab = vi.fn()
  const { result } = renderHook(() =>
    useNewWorktreeKeyboard({
      activeTab: 'quick',
      setActiveTab,
      githubOnlyTabsEnabled,
      selectedItemIndex: 0,
    } as unknown as Options)
  )
  const preventDefault = vi.fn()
  result.current.handleKeyDown({
    key,
    metaKey: true,
    ctrlKey: false,
    preventDefault,
  } as unknown as React.KeyboardEvent)
  return { setActiveTab, preventDefault }
}

describe('useNewWorktreeKeyboard tab shortcuts', () => {
  it('maps mod+digit to the tab in display order', () => {
    expect(pressMod(true, '3').setActiveTab).toHaveBeenCalledWith('prs')
    expect(pressMod(true, '4').setActiveTab).toHaveBeenCalledWith('discussions')
    expect(pressMod(true, '5').setActiveTab).toHaveBeenCalledWith('security')
    expect(pressMod(true, '8').setActiveTab).toHaveBeenCalledWith('sentry')
  })

  it('ignores GitHub-only tab shortcuts for GitLab projects', () => {
    const discussions = pressMod(false, '4')
    expect(discussions.setActiveTab).not.toHaveBeenCalled()
    expect(discussions.preventDefault).toHaveBeenCalled()
    expect(pressMod(false, '6').setActiveTab).toHaveBeenCalledWith('branches')
  })
})
