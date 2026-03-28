import { useMemo } from 'react'
import {
  CircleDot,
  GitPullRequest,
  GitMerge,
  Loader2,
  MessageSquare,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  ExternalLink,
  ShieldAlert,
  Package,
  FileCode,
} from 'lucide-react'
import { openExternal } from '@/lib/platform'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import {
  useGitHubIssue,
  useGitHubPR,
  useDependabotAlert,
  useRepositoryAdvisory,
} from '@/services/github'
import type {
  GitHubIssueDetail,
  GitHubPullRequestDetail,
  GitHubComment,
  GitHubReview,
  GitHubLabel,
  DependabotAlert,
  RepositoryAdvisory,
} from '@/types/github'

interface IssuePreviewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  type: 'issue' | 'pr' | 'security' | 'advisory'
  number: number
  ghsaId?: string
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// Detail endpoints use serde rename_all = "camelCase", so created_at becomes createdAt at runtime
function getCreatedAt(obj: { created_at: string }): string {
  return (
    obj.created_at || (obj as unknown as { createdAt: string }).createdAt || ''
  )
}

function Labels({ labels }: { labels: GitHubLabel[] }) {
  if (labels.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map(label => (
        <span
          key={label.name}
          className="px-2 py-0.5 text-xs rounded-full font-medium"
          style={{
            backgroundColor: `#${label.color}20`,
            color: `#${label.color}`,
            border: `1px solid #${label.color}40`,
          }}
        >
          {label.name}
        </span>
      ))}
    </div>
  )
}

function CommentItem({ comment }: { comment: GitHubComment }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/50 border-b border-border">
        <span className="text-sm font-medium">{comment.author.login}</span>
        <span className="text-xs text-muted-foreground">
          commented on {formatDate(getCreatedAt(comment))}
        </span>
      </div>
      <div className="px-4 py-3">
        {comment.body ? (
          <Markdown className="text-sm">{comment.body}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            No description provided.
          </p>
        )}
      </div>
    </div>
  )
}

function ReviewItem({ review }: { review: GitHubReview }) {
  const defaultConfig = {
    icon: MessageSquare,
    color: 'text-muted-foreground',
    label: 'Reviewed',
  }
  const stateConfig: Record<
    string,
    { icon: typeof CheckCircle2; color: string; label: string }
  > = {
    APPROVED: {
      icon: CheckCircle2,
      color: 'text-green-500',
      label: 'Approved',
    },
    CHANGES_REQUESTED: {
      icon: XCircle,
      color: 'text-red-500',
      label: 'Changes requested',
    },
    COMMENTED: defaultConfig,
    DISMISSED: {
      icon: AlertCircle,
      color: 'text-yellow-500',
      label: 'Dismissed',
    },
    PENDING: { icon: Clock, color: 'text-yellow-500', label: 'Pending' },
  }

  const config = stateConfig[review.state] ?? defaultConfig
  const Icon = config.icon

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/50 border-b border-border">
        <Icon className={cn('h-4 w-4', config.color)} />
        <span className="text-sm font-medium">{review.author.login}</span>
        <span className={cn('text-xs font-medium', config.color)}>
          {config.label}
        </span>
        {review.submittedAt && (
          <span className="text-xs text-muted-foreground">
            on {formatDate(review.submittedAt)}
          </span>
        )}
      </div>
      {review.body && (
        <div className="px-4 py-3">
          <Markdown className="text-sm">{review.body}</Markdown>
        </div>
      )}
    </div>
  )
}

function IssueContent({ detail }: { detail: GitHubIssueDetail }) {
  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3">
        <CircleDot
          className={cn(
            'h-5 w-5 mt-0.5 flex-shrink-0',
            detail.state === 'OPEN' ? 'text-green-500' : 'text-purple-500'
          )}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug">
            {detail.title}{' '}
            <span className="text-muted-foreground font-normal">
              #{detail.number}
            </span>
          </h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span>{detail.author.login}</span>
            <span>opened on {formatDate(getCreatedAt(detail))}</span>
          </div>
        </div>
      </div>

      <Labels labels={detail.labels} />

      {/* Body */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/50 border-b border-border">
          <span className="text-sm font-medium">{detail.author.login}</span>
          <span className="text-xs text-muted-foreground">
            opened this issue on {formatDate(getCreatedAt(detail))}
          </span>
        </div>
        <div className="px-4 py-3">
          {detail.body ? (
            <Markdown className="text-sm">{detail.body}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No description provided.
            </p>
          )}
        </div>
      </div>

      {/* Comments */}
      {detail.comments.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" />
            <span>
              {detail.comments.length} comment
              {detail.comments.length !== 1 && 's'}
            </span>
          </div>
          {detail.comments.map((comment, i) => (
            <CommentItem
              key={`comment-${comment.author.login}-${comment.created_at}-${i}`}
              comment={comment}
            />
          ))}
        </div>
      )}
    </>
  )
}

function PRContent({ detail }: { detail: GitHubPullRequestDetail }) {
  const stateIcon = useMemo(() => {
    if (detail.state === 'MERGED')
      return (
        <GitMerge className="h-5 w-5 mt-0.5 flex-shrink-0 text-purple-500" />
      )
    if (detail.state === 'CLOSED')
      return (
        <GitPullRequest className="h-5 w-5 mt-0.5 flex-shrink-0 text-red-500" />
      )
    return (
      <GitPullRequest className="h-5 w-5 mt-0.5 flex-shrink-0 text-green-500" />
    )
  }, [detail.state])

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3">
        {stateIcon}
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug">
            {detail.title}{' '}
            <span className="text-muted-foreground font-normal">
              #{detail.number}
            </span>
          </h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
            <span>{detail.author.login}</span>
            <span>opened on {formatDate(getCreatedAt(detail))}</span>
            {detail.isDraft && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs">
                Draft
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 text-xs">
            <code className="bg-muted px-1.5 py-0.5 rounded font-mono">
              {detail.headRefName}
            </code>
            <span className="text-muted-foreground">→</span>
            <code className="bg-muted px-1.5 py-0.5 rounded font-mono">
              {detail.baseRefName}
            </code>
          </div>
        </div>
      </div>

      <Labels labels={detail.labels} />

      {/* Body */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/50 border-b border-border">
          <span className="text-sm font-medium">{detail.author.login}</span>
          <span className="text-xs text-muted-foreground">
            opened this pull request on {formatDate(getCreatedAt(detail))}
          </span>
        </div>
        <div className="px-4 py-3">
          {detail.body ? (
            <Markdown className="text-sm">{detail.body}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No description provided.
            </p>
          )}
        </div>
      </div>

      {/* Reviews */}
      {detail.reviews.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            <span>
              {detail.reviews.length} review{detail.reviews.length !== 1 && 's'}
            </span>
          </div>
          {detail.reviews.map((review, i) => (
            <ReviewItem
              key={`review-${review.author.login}-${review.submittedAt ?? i}`}
              review={review}
            />
          ))}
        </div>
      )}

      {/* Comments */}
      {detail.comments.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" />
            <span>
              {detail.comments.length} comment
              {detail.comments.length !== 1 && 's'}
            </span>
          </div>
          {detail.comments.map((comment, i) => (
            <CommentItem
              key={`comment-${comment.author.login}-${comment.created_at}-${i}`}
              comment={comment}
            />
          ))}
        </div>
      )}
    </>
  )
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-600 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-600 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/30',
  low: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
}

function SecurityAlertContent({ alert }: { alert: DependabotAlert }) {
  const severityClass =
    SEVERITY_COLORS[alert.severity] ??
    'bg-muted text-muted-foreground border-border'

  const stateLabel =
    alert.state === 'auto_dismissed' ? 'Auto-dismissed' : alert.state
  const stateColors: Record<string, string> = {
    open: 'text-red-500',
    fixed: 'text-green-500',
    dismissed: 'text-muted-foreground',
    auto_dismissed: 'text-muted-foreground',
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 mt-0.5 flex-shrink-0 text-orange-500" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug">
            Dependabot Alert{' '}
            <span className="text-muted-foreground font-normal">
              #{alert.number}
            </span>
          </h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span>opened on {formatDate(alert.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Severity badge */}
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'px-3 py-1 text-sm font-semibold rounded-md border capitalize',
            severityClass
          )}
        >
          {alert.severity}
        </span>
        <span
          className={cn(
            'text-sm font-medium capitalize',
            stateColors[alert.state] ?? 'text-muted-foreground'
          )}
        >
          {stateLabel}
        </span>
      </div>

      {/* Details */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/50 border-b border-border">
          <span className="text-sm font-medium">Advisory Details</span>
        </div>
        <div className="px-4 py-3 space-y-3">
          {/* Summary */}
          <p className="text-sm">{alert.summary}</p>

          {/* Advisory IDs */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">GHSA:</span>{' '}
              {alert.ghsaId}
            </span>
            {alert.cveId && (
              <span>
                <span className="font-medium text-foreground">CVE:</span>{' '}
                {alert.cveId}
              </span>
            )}
          </div>

          {/* Package info */}
          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-center gap-2">
              <Package className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-muted-foreground">Package:</span>
              <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">
                {alert.packageName}
              </code>
              <span className="text-xs text-muted-foreground">
                ({alert.packageEcosystem})
              </span>
            </div>
            <div className="flex items-center gap-2">
              <FileCode className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-muted-foreground">Manifest:</span>
              <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">
                {alert.manifestPath}
              </code>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function AdvisoryContent({ advisory }: { advisory: RepositoryAdvisory }) {
  const severityClass =
    SEVERITY_COLORS[advisory.severity] ??
    'bg-muted text-muted-foreground border-border'

  const stateColors: Record<string, string> = {
    published: 'text-orange-500',
    closed: 'text-green-500',
    draft: 'text-muted-foreground',
    triage: 'text-yellow-500',
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 mt-0.5 flex-shrink-0 text-orange-500" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug">
            Repository Advisory{' '}
            <span className="text-muted-foreground font-normal">
              {advisory.ghsaId}
            </span>
          </h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            {advisory.authorLogin && <span>{advisory.authorLogin}</span>}
            <span>created on {formatDate(advisory.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Severity badge */}
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'px-3 py-1 text-sm font-semibold rounded-md border capitalize',
            severityClass
          )}
        >
          {advisory.severity}
        </span>
        <span
          className={cn(
            'text-sm font-medium capitalize',
            stateColors[advisory.state] ?? 'text-muted-foreground'
          )}
        >
          {advisory.state}
        </span>
      </div>

      {/* Details */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/50 border-b border-border">
          <span className="text-sm font-medium">Advisory Details</span>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-sm">{advisory.summary}</p>

          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">GHSA:</span>{' '}
              {advisory.ghsaId}
            </span>
            {advisory.cveId && (
              <span>
                <span className="font-medium text-foreground">CVE:</span>{' '}
                {advisory.cveId}
              </span>
            )}
          </div>

          {advisory.description && (
            <div className="pt-2">
              <Markdown className="text-sm">{advisory.description}</Markdown>
            </div>
          )}
        </div>
      </div>

      {/* Vulnerabilities */}
      {advisory.vulnerabilities.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Package className="h-4 w-4" />
            <span>
              {advisory.vulnerabilities.length} affected package
              {advisory.vulnerabilities.length !== 1 && 's'}
            </span>
          </div>
          {advisory.vulnerabilities.map((vuln, i) => (
            <div
              key={`vuln-${vuln.packageName}-${i}`}
              className="border border-border rounded-lg overflow-hidden"
            >
              <div className="px-4 py-2.5 bg-muted/50 border-b border-border">
                <div className="flex items-center gap-2">
                  <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">
                    {vuln.packageName}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    ({vuln.packageEcosystem})
                  </span>
                </div>
              </div>
              <div className="px-4 py-2.5 space-y-1 text-sm">
                {vuln.vulnerableVersionRange && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Vulnerable:</span>
                    <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">
                      {vuln.vulnerableVersionRange}
                    </code>
                  </div>
                )}
                {vuln.patchedVersions && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Patched:</span>
                    <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs">
                      {vuln.patchedVersions}
                    </code>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

const TYPE_LABELS: Record<IssuePreviewModalProps['type'], string> = {
  issue: 'Issue',
  pr: 'Pull Request',
  security: 'Dependabot Alert',
  advisory: 'Repository Advisory',
}

export function IssuePreviewModal({
  open,
  onOpenChange,
  projectPath,
  type,
  number,
  ghsaId,
}: IssuePreviewModalProps) {
  const issueQuery = useGitHubIssue(
    projectPath,
    type === 'issue' ? number : null
  )
  const prQuery = useGitHubPR(projectPath, type === 'pr' ? number : null)
  const securityQuery = useDependabotAlert(
    projectPath,
    type === 'security' ? number : null
  )
  const advisoryQuery = useRepositoryAdvisory(
    projectPath,
    type === 'advisory' ? (ghsaId ?? null) : null
  )

  const activeQuery =
    type === 'issue'
      ? issueQuery
      : type === 'pr'
        ? prQuery
        : type === 'advisory'
          ? advisoryQuery
          : securityQuery
  const isLoading = activeQuery.isLoading
  const error = activeQuery.error

  const githubUrl =
    type === 'issue'
      ? issueQuery.data?.url
      : type === 'pr'
        ? prQuery.data?.url
        : type === 'advisory'
          ? advisoryQuery.data?.htmlUrl
          : securityQuery.data?.ghsaId
            ? `https://github.com/advisories/${securityQuery.data.ghsaId}`
            : securityQuery.data?.htmlUrl

  return (
    <Dialog
      open={open}
      onOpenChange={open => {
        console.log('[DIALOG-DEBUG] Preview onOpenChange', { open })
        onOpenChange(open)
      }}
    >
      <DialogContent className="!fixed !inset-0 !translate-x-0 !translate-y-0 !w-screen !h-[100dvh] !max-w-none !max-h-none !rounded-none sm:!inset-auto sm:!top-[50%] sm:!left-[50%] sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:!w-[90vw] sm:!max-w-4xl sm:!h-[85vh] sm:!max-h-[85vh] sm:!rounded-lg flex flex-col overflow-hidden z-[80] [&>[data-slot=dialog-close]]:top-6">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="text-lg flex items-center gap-2">
            {TYPE_LABELS[type]} {type === 'advisory' ? ghsaId : `#${number}`}
            {githubUrl && (
              <button
                onClick={() => openExternal(githubUrl)}
                className="p-1 rounded hover:bg-accent transition-colors"
                title="Open on GitHub"
              >
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="select-text space-y-4 pr-4 pb-4">
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {error && (
              <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
                <AlertCircle className="h-6 w-6" />
                <p>Failed to load {TYPE_LABELS[type].toLowerCase()} details.</p>
                <p className="text-xs">{String(error)}</p>
              </div>
            )}

            {!isLoading && !error && type === 'issue' && issueQuery.data && (
              <IssueContent detail={issueQuery.data} />
            )}

            {!isLoading && !error && type === 'pr' && prQuery.data && (
              <PRContent detail={prQuery.data} />
            )}

            {!isLoading &&
              !error &&
              type === 'security' &&
              securityQuery.data && (
                <SecurityAlertContent alert={securityQuery.data} />
              )}

            {!isLoading &&
              !error &&
              type === 'advisory' &&
              advisoryQuery.data && (
                <AdvisoryContent advisory={advisoryQuery.data} />
              )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
