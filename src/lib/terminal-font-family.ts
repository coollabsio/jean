/**
 * Sanitize a user-supplied terminal font family.
 *
 * The value is used as a CSS `font-family` string in xterm, so control
 * characters must be stripped. A missing or blank value means "fall back".
 */
export function resolveCustomTerminalFont(
  value: string | null | undefined
): string | null {
  if (!value) return null
  const cleaned = Array.from(value)
    .filter(character => {
      const code = character.codePointAt(0) ?? 32
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
  return cleaned || null
}
