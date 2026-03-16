/**
 * Generate a UUID v4 string with fallback for non-secure contexts.
 *
 * crypto.randomUUID() requires a secure context (HTTPS/localhost).
 * When running in an HTTP web view, we fall back to crypto.getRandomValues()
 * which IS available in non-secure contexts.
 */
export function generateId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0
    return (+c ^ (r & (15 >> (+c / 4)))).toString(16)
  })
}
