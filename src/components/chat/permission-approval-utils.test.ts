import { describe, expect, it } from 'vitest'
import {
  getCodexPermissionApprovalMode,
  shouldShowPermissionApproval,
} from './permission-approval-utils'

describe('permission approval utils', () => {
  it('shows approval for idle non-codex sessions with pending denials', () => {
    expect(
      shouldShowPermissionApproval({
        pendingDenialsCount: 1,
        isSending: false,
        executionMode: 'plan',
        isCodexBackend: false,
      })
    ).toBe(true)
  })

  it('keeps approval visible during codex streaming', () => {
    expect(
      shouldShowPermissionApproval({
        pendingDenialsCount: 1,
        isSending: true,
        executionMode: 'plan',
        isCodexBackend: true,
      })
    ).toBe(true)
  })

  it('hides approval during non-codex streaming', () => {
    expect(
      shouldShowPermissionApproval({
        pendingDenialsCount: 1,
        isSending: true,
        executionMode: 'plan',
        isCodexBackend: false,
      })
    ).toBe(false)
  })

  it('hides approval in yolo mode', () => {
    expect(
      shouldShowPermissionApproval({
        pendingDenialsCount: 1,
        isSending: true,
        executionMode: 'yolo',
        isCodexBackend: true,
      })
    ).toBe(false)
  })

  it('preserves plan mode for normal codex approvals', () => {
    expect(getCodexPermissionApprovalMode('plan', false)).toBe('plan')
  })

  it('switches to yolo when requested', () => {
    expect(getCodexPermissionApprovalMode('plan', true)).toBe('yolo')
  })
})
