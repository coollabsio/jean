/**
 * GitHub issue types for the New Worktree modal
 */

export interface GitHubLabel {
  name: string
  color: string
}

export interface GitHubAuthor {
  login: string
}

export interface GitHubIssue {
  number: number
  title: string
  body?: string
  state: string
  labels: GitHubLabel[]
  created_at: string
  author: GitHubAuthor
}

export interface GitHubIssueListResult {
  issues: GitHubIssue[]
  totalCount: number
}

export interface GitHubComment {
  body: string
  author: GitHubAuthor
  created_at: string // From GitHub API (snake_case)
}

// Comment format for sending to backend (camelCase)
export interface IssueComment {
  body: string
  author: GitHubAuthor
  createdAt: string
}

export interface GitHubIssueDetail extends GitHubIssue {
  url: string
  comments: GitHubComment[]
}

/**
 * Issue context to pass when creating a worktree
 * Uses camelCase to match Rust backend expectations
 */
export interface IssueContext {
  number: number
  title: string
  body?: string
  comments: IssueComment[]
}

/**
 * Loaded issue context info (from backend)
 */
export interface LoadedIssueContext {
  number: number
  title: string
  commentCount: number
  repoOwner: string
  repoName: string
}

// =============================================================================
// GitHub Pull Request Types
// =============================================================================

export interface GitHubPullRequest {
  number: number
  title: string
  body?: string
  state: string
  headRefName: string
  baseRefName: string
  isDraft: boolean
  created_at: string // From GitHub API (snake_case)
  author: GitHubAuthor
  labels: GitHubLabel[]
}

export interface GitHubReview {
  body: string
  state: string
  author: GitHubAuthor
  submittedAt?: string
}

/** Inline code review comment on specific diff lines */
export interface GitHubReviewComment {
  author: GitHubAuthor
  body: string
  createdAt: string
  diffHunk: string
  path: string
  startLine?: number
  line?: number
}

export interface GitHubPullRequestDetail extends GitHubPullRequest {
  url: string
  comments: GitHubComment[]
  reviews: GitHubReview[]
}

/**
 * PR context to pass when creating a worktree
 */
export interface PullRequestContext {
  number: number
  title: string
  body?: string
  headRefName: string
  baseRefName: string
  comments: IssueComment[]
  reviews: GitHubReview[]
  diff?: string
}

/**
 * Loaded PR context info (from backend)
 */
export interface LoadedPullRequestContext {
  number: number
  title: string
  commentCount: number
  reviewCount: number
  repoOwner: string
  repoName: string
}

// =============================================================================
// Dependabot Alert / Security Types
// =============================================================================

export interface DependabotAlert {
  number: number
  state: string // "open" | "dismissed" | "fixed" | "auto_dismissed"
  packageName: string
  packageEcosystem: string
  manifestPath: string
  ghsaId: string
  cveId?: string
  severity: string // "low" | "medium" | "high" | "critical"
  summary: string
  description: string
  createdAt: string
  htmlUrl: string
}

/**
 * Security alert context to pass when creating a worktree
 * Uses camelCase to match Rust backend expectations
 */
export interface SecurityAlertContext {
  number: number
  packageName: string
  packageEcosystem: string
  severity: string
  summary: string
  description: string
  ghsaId: string
  cveId?: string
  manifestPath: string
  htmlUrl?: string
}

/**
 * Loaded security alert context info (from backend)
 */
export interface LoadedSecurityAlertContext {
  number: number
  packageName: string
  severity: string
  summary: string
  repoOwner: string
  repoName: string
}

// =============================================================================
// Repository Security Advisory Types
// =============================================================================

export interface AdvisoryVulnerability {
  packageName: string
  packageEcosystem: string
  vulnerableVersionRange?: string
  patchedVersions?: string
}

export interface RepositoryAdvisory {
  ghsaId: string
  cveId?: string
  summary: string
  description: string
  severity: string
  state: string // "triage" | "draft" | "published" | "closed"
  authorLogin?: string
  createdAt: string
  publishedAt?: string
  htmlUrl: string
  vulnerabilities: AdvisoryVulnerability[]
}

/**
 * Advisory context to pass when creating a worktree
 */
export interface AdvisoryContext {
  ghsaId: string
  severity: string
  summary: string
  description: string
  cveId?: string
  vulnerabilities: AdvisoryVulnerability[]
  htmlUrl?: string
}

/**
 * Loaded advisory context info (from backend)
 */
export interface LoadedAdvisoryContext {
  ghsaId: string
  severity: string
  summary: string
  repoOwner: string
  repoName: string
}

// =============================================================================
// GitHub Actions Workflow Run Types
// =============================================================================

export interface WorkflowRun {
  databaseId: number
  name: string
  displayTitle: string
  status: string // "completed" | "in_progress" | "queued"
  conclusion: string | null // "success" | "failure" | "cancelled" | "skipped" | "startup_failure" | null
  event: string
  headBranch: string
  createdAt: string
  url: string
  workflowName: string
}

export interface WorkflowRunsResult {
  runs: WorkflowRun[]
  failedCount: number
}

// =============================================================================
// Attached Saved Context Types
// =============================================================================

/**
 * Attached saved context info (from backend)
 * Uses camelCase to match Rust #[serde(rename_all = "camelCase")]
 */
export interface AttachedSavedContext {
  slug: string
  name?: string
  size: number
  createdAt: number
}
