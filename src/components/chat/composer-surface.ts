/** Shared surface of the chat composer and the panels docked above it. */
export const COMPOSER_SURFACE_CLASS =
  'border-t border-border/30 bg-card sm:border dark:bg-[color-mix(in_oklab,var(--background),white_3%)]'

/** Small tab buttons that sit on top of the composer (Bottom, Findings, Goal, ...). */
export const COMPOSER_TAB_CLASS =
  'flex h-6 items-center gap-1 rounded-t-md border border-b-0 border-border/30 bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:bg-[color-mix(in_oklab,var(--background),white_3%)] dark:hover:bg-muted'
