import type { ExecutionMode, PermissionDenial } from '@/types/chat'

interface PermissionApprovalVisibilityParams {
  pendingDenialsCount: number
  isSending: boolean
  executionMode: ExecutionMode
  isCodexBackend: boolean
  /** A Claude Supervised run is waiting for the answer (live request). */
  hasLiveRequest: boolean
}

/** Claude live request: the run waits on Jean MCP until the user answers. */
export function isLivePermissionRequest(denial: PermissionDenial): boolean {
  return denial.rpc_id != null
}

export function shouldShowPermissionApproval({
  pendingDenialsCount,
  isSending,
  executionMode,
  isCodexBackend,
  hasLiveRequest,
}: PermissionApprovalVisibilityParams): boolean {
  if (pendingDenialsCount === 0) return false
  if (executionMode === 'yolo') return false

  return !isSending || isCodexBackend || hasLiveRequest
}

export function getCodexPermissionApprovalMode(
  currentMode: ExecutionMode,
  approveWithYolo: boolean
): ExecutionMode {
  return approveWithYolo ? 'yolo' : currentMode
}
