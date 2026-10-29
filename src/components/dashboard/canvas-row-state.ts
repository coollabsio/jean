import type { CheckStatus, MergeableStatus } from '@/types/pr-status'

/** The one state a compact (mobile) canvas row shows and is grouped by. */
export type CanvasRowState = 'waiting' | 'running' | 'idle'

export const CANVAS_ROW_STATE_LABELS: Record<CanvasRowState, string> = {
  waiting: 'Needs input',
  running: 'Running',
  idle: 'Idle',
}

const CANVAS_ROW_STATE_ORDER: CanvasRowState[] = ['waiting', 'running', 'idle']

/** Waiting wins over running: a row that needs the user is the most urgent. */
export function getCanvasRowState({
  waitingCount,
  runningCount,
  isPending = false,
}: {
  waitingCount: number
  runningCount: number
  isPending?: boolean
}): CanvasRowState {
  if (waitingCount > 0) return 'waiting'
  if (runningCount > 0 || isPending) return 'running'
  return 'idle'
}

/** Stable sort by state group; keeps the incoming order inside each group. */
export function sortByCanvasRowState<T>(
  items: T[],
  getState: (item: T) => CanvasRowState
): T[] {
  return items
    .map((item, index) => ({
      item,
      index,
      rank: CANVAS_ROW_STATE_ORDER.indexOf(getState(item)),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.item)
}

export type CanvasRowAttention = 'checks_failing' | 'conflicts'

/** Only problems the user must act on earn a badge in a compact row. */
export function getCanvasRowAttention({
  checkStatus,
  mergeable,
}: {
  checkStatus?: CheckStatus | null
  mergeable?: MergeableStatus | null
}): CanvasRowAttention | null {
  if (mergeable === 'conflicting') return 'conflicts'
  if (checkStatus === 'failure' || checkStatus === 'error') {
    return 'checks_failing'
  }
  return null
}
