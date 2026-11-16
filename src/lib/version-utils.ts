/**
 * Version comparison utilities
 *
 * Provides semver-style version comparison for CLI version checks.
 */

/**
 * Parse a version string into numeric parts.
 * Handles versions like "1.0.0", "1.0.0-beta.1", etc.
 * Only compares the main version numbers (before any hyphen).
 */
function parseVersion(version: string): number[] {
  // Remove leading 'v' if present
  const cleaned = version.startsWith('v') ? version.slice(1) : version
  // Take only the main version part (before any hyphen for pre-release)
  const main = cleaned.split('-')[0] ?? cleaned
  return main.split('.').map(n => parseInt(n, 10) || 0)
}

/**
 * Compare two semver versions.
 * @returns positive if a > b, negative if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const aParts = parseVersion(a)
  const bParts = parseVersion(b)

  const maxLength = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < maxLength; i++) {
    const aVal = aParts[i] ?? 0
    const bVal = bParts[i] ?? 0

    if (aVal !== bVal) {
      return aVal - bVal
    }
  }

  return 0
}

/**
 * Check if version A is newer than version B.
 */
export function isNewerVersion(a: string, b: string): boolean {
  return compareVersions(a, b) > 0
}

/**
 * Newest stable release to offer as an update for `installed`, or undefined.
 * `versions` is newest first. With `sameMajor`, releases of another major
 * version are skipped.
 */
export function latestStableUpdate<
  T extends { version: string; prerelease?: boolean },
>(versions: T[], installed: string, sameMajor = false): T | undefined {
  const major = parseVersion(installed)[0]
  const latest = versions.find(
    v => !v.prerelease && (!sameMajor || parseVersion(v.version)[0] === major)
  )
  return latest && isNewerVersion(latest.version, installed)
    ? latest
    : undefined
}
