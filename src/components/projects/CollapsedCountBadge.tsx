interface CollapsedCountBadgeProps {
  count: number
  label: 'items' | 'workspaces' | 'sessions'
  isExpanded: boolean
}

export function CollapsedCountBadge({
  count,
  label,
  isExpanded,
}: CollapsedCountBadgeProps) {
  if (isExpanded || count < 1) return null

  const singular = label === 'items' ? 'item' : label.slice(0, -1)

  return (
    <span
      role="status"
      aria-label={`${count} ${count === 1 ? singular : label}`}
      className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {count}
    </span>
  )
}
