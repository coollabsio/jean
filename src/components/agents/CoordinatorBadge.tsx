import { Badge } from '@/components/ui/badge'

/** Marks a worktree or session the project coordinator waits for. */
export function CoordinatorBadge() {
  return (
    <Badge
      variant="subtle"
      className="shrink-0 px-1 py-0 text-2xs font-normal leading-4"
      title="Working for the project coordinator"
    >
      Coord.
    </Badge>
  )
}
