import { LoaderCircle } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'

export function MinimizedCliUpdate() {
  const update = useUIStore(state => state.minimizedCliUpdate)
  const restore = useUIStore(state => state.restoreMinimizedCliUpdate)

  if (!update) return null

  const status =
    update.kind === 'reinstall' && update.progress !== null
      ? `${Math.round(update.progress)}%`
      : 'Updating…'
  const accessibleStatus = status.replace('…', '')

  return (
    <button
      type="button"
      onClick={restore}
      aria-label={`${update.name} update: ${accessibleStatus}`}
      className="mr-1.5 flex items-center gap-1.5 rounded-md bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary transition-colors hover:bg-primary/25 cursor-pointer"
    >
      <LoaderCircle className="size-3 animate-spin" aria-hidden />
      <span>{update.name}</span>
      <span>{status}</span>
    </button>
  )
}
