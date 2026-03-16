// Label color utilities

/** Colors that need black text for contrast (light backgrounds) */
export const LABEL_CONTRAST_LIGHT_COLORS = [
  '#eab308', // Yellow
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#06b6d4', // Cyan
  '#84cc16', // Lime
  '#f97316', // Orange
]

/**
 * Get the appropriate text color (black or white) for a label background color.
 * Uses white text for better visibility on most colors.
 */
export function getLabelTextColor(bgColor: string): 'black' | 'white' {
  return LABEL_CONTRAST_LIGHT_COLORS.includes(bgColor) ? 'black' : 'white'
}
