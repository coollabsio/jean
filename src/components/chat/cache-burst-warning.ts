/**
 * When to warn that changing the effort level can invalidate the prompt cache.
 *
 * Kept pure so the condition is testable without mounting the chat window.
 */
export function shouldWarnAboutCacheBurst(
  enabled: boolean,
  hasMessages: boolean,
  currentLevel: string | undefined | null,
  nextLevel: string
): boolean {
  return enabled && hasMessages && !!currentLevel && currentLevel !== nextLevel
}
