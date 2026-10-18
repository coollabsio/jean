import { describe, expect, it } from 'vitest'
import {
  getCodexPermissionApprovalMode,
  isLivePermissionRequest,
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
        hasLiveRequest: false,
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
        hasLiveRequest: false,
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
        hasLiveRequest: false,
      })
    ).toBe(false)
  })

  it('shows live Claude requests during streaming', () => {
    expect(
      shouldShowPermissionApproval({
        pendingDenialsCount: 1,
        isSending: true,
        executionMode: 'supervised',
        isCodexBackend: false,
        hasLiveRequest: true,
      })
    ).toBe(true)
  })

  it('marks only denials with rpc_id as live requests', () => {
    const denial = { tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }
    expect(isLivePermissionRequest(denial)).toBe(false)
    expect(isLivePermissionRequest({ ...denial, rpc_id: 0 })).toBe(true)
  })

  it('hides approval in yolo mode', () => {
    expect(
      shouldShowPermissionApproval({
        pendingDenialsCount: 1,
        isSending: true,
        executionMode: 'yolo',
        isCodexBackend: true,
        hasLiveRequest: false,
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
