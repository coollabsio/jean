import { toast } from 'sonner'

/** Shared toast summary after a multi-select bulk investigate run. */
export function reportBulkInvestigateResults(
  toastId: string | number,
  succeeded: number,
  failed: number,
  nounSingular: string,
  nounPlural: string
): void {
  const noun = (n: number) => (n === 1 ? nounSingular : nounPlural)

  if (failed === 0) {
    toast.success(
      `Investigating ${succeeded} ${noun(succeeded)} in background`,
      { id: toastId }
    )
  } else if (succeeded === 0) {
    toast.error(
      `Failed to start investigation for ${failed} ${noun(failed)}`,
      { id: toastId }
    )
  } else {
    toast.warning(
      `Investigating ${succeeded} in background; ${failed} failed`,
      { id: toastId }
    )
  }
}
