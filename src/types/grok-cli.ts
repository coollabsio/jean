/**
 * Types for Grok Build CLI management.
 */

export interface GrokCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface GrokAuthStatus {
  authenticated: boolean
  error: string | null
  timedOut?: boolean
}

export interface GrokModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

export interface GrokReleaseInfo {
  version: string
  tagName: string
  publishedAt: string
  prerelease: boolean
}

export interface GrokInstallCommand {
  command: string
  args: string[]
  description: string
}

export interface GrokUsageWindowSnapshot {
  usedPercent: number
  resetsAt: number | null
  limitWindowSeconds: number | null
}

export interface GrokProductUsageSnapshot {
  product: string
  usedPercent: number
}

export interface GrokUsageSnapshot {
  planType: string | null
  /** Overall weekly credit usage */
  weekly: GrokUsageWindowSnapshot | null
  /** Grok Build product usage (primary CLI product) */
  session: GrokUsageWindowSnapshot | null
  products: GrokProductUsageSnapshot[]
  frequentUsed: number | null
  frequentLimit: number | null
  occasionalUsed: number | null
  occasionalLimit: number | null
  hasGrokCodeAccess: boolean | null
  periodStart: string | null
  periodEnd: string | null
  fetchedAt: number
}
