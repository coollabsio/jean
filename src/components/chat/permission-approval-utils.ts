import type { ExecutionMode } from '@/types/chat'

interface PermissionApprovalVisibilityParams {
  pendingDenialsCount: number
  isSending: boolean
  executionMode: ExecutionMode
  isCodexBackend: boolean
}

export function shouldShowPermissionApproval({
  pendingDenialsCount,
  isSending,
  executionMode,
  isCodexBackend,
}: PermissionApprovalVisibilityParams): boolean {
  if (pendingDenialsCount === 0) return false
  if (executionMode === 'yolo') return false

  return !isSending || isCodexBackend
}

export function getCodexPermissionApprovalMode(
  currentMode: ExecutionMode,
  approveWithYolo: boolean
): ExecutionMode {
  return approveWithYolo ? 'yolo' : currentMode
}
