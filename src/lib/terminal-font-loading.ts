export async function ensureTerminalFontLoaded(
  fontFamily: string,
  fontSize: number
): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return

  try {
    const probe = 'Jean terminal font probe ➜ ✗'
    await Promise.all([
      document.fonts.load(`400 ${fontSize}px ${fontFamily}`, probe),
      document.fonts.load(`500 ${fontSize}px ${fontFamily}`, probe),
    ])
  } catch {
    // Keep the terminal usable with the configured fallback font.
  }
}
