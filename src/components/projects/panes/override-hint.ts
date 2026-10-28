/** Row hint for a project setting that can override a global one. */
export function overrideHint(
  overridden: boolean,
  globalValue?: string | null
): string {
  if (overridden) return 'Overrides global'
  return globalValue
    ? `Inherits global: ${globalValue}`
    : 'Inherits global setting'
}
