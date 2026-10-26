export type GitProvider = 'github' | 'gitlab' | 'custom'

const providerHosts: Record<Exclude<GitProvider, 'custom'>, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
}

export function buildCloneUrl(provider: GitProvider, value: string): string {
  const repository = value.trim()
  if (provider === 'custom') return repository
  return `${providerHosts[provider]}/${repository.replace(/^\/+/, '')}`
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Hostnames Jean treats as GitLab, including self-hosted `gitlab.example.com`. */
export function hostLooksLikeGitlab(host: string): boolean {
  const lower = host.trim().toLowerCase()
  return lower === 'gitlab.com' || lower.includes('gitlab')
}

export function webUrlLooksLikeGitlab(url: string): boolean {
  try {
    return hostLooksLikeGitlab(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * GitLab web paths when the project provider is GitLab, or when the URL host
 * itself looks like GitLab. Self-hosted instances whose hostname does not
 * contain `gitlab` rely on the resolved provider.
 */
export function usesGitlabWebPaths(
  provider: GitProvider | undefined,
  url?: string
): boolean {
  if (provider === 'gitlab') return true
  return url ? webUrlLooksLikeGitlab(url) : false
}

/** `https://host/owner/repo`, keeping a nested GitLab group inside `owner`. */
export function hostedRepoWebUrl(
  host: string,
  owner: string,
  repo: string
): string {
  const bare = host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  return `https://${bare}/${owner}/${repo}`
}

export function branchWebUrl(
  repoWebUrl: string,
  branch: string,
  provider?: GitProvider
): string {
  const base = trimTrailingSlash(repoWebUrl)
  const segment = usesGitlabWebPaths(provider, repoWebUrl)
    ? '/-/tree/'
    : '/tree/'
  return `${base}${segment}${branch}`
}

export function issueWebUrl(
  repoWebUrl: string,
  number: number,
  provider?: GitProvider
): string {
  const base = trimTrailingSlash(repoWebUrl)
  const path = usesGitlabWebPaths(provider, repoWebUrl)
    ? `/-/issues/${number}`
    : `/issues/${number}`
  return `${base}${path}`
}

export function pullRequestWebUrl(
  repoWebUrl: string,
  number: number,
  provider?: GitProvider
): string {
  const base = trimTrailingSlash(repoWebUrl)
  const path = usesGitlabWebPaths(provider, repoWebUrl)
    ? `/-/merge_requests/${number}`
    : `/pull/${number}`
  return `${base}${path}`
}
