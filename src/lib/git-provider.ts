export type GitProvider = 'github' | 'gitlab' | 'custom'

const providerHosts: Record<Exclude<GitProvider, 'custom'>, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
}

/**
 * Removes a pasted provider host (`https://github.com/`, `git@github.com:`)
 * so the input keeps only `owner/repo`. Custom input stays unchanged.
 */
export function stripProviderHost(
  provider: GitProvider,
  value: string
): string {
  if (provider === 'custom') return value
  const host = new URL(providerHosts[provider]).hostname.replace(/\./g, '\\.')
  const prefix = new RegExp(
    `^\\s*(?:(?:https?|ssh|git)://)?(?:[^@/\\s]+@)?(?:www\\.)?${host}[/:]+`,
    'i'
  )
  return value.replace(prefix, '')
}

export function buildCloneUrl(provider: GitProvider, value: string): string {
  const repository = value.trim()
  if (provider === 'custom') return repository
  const path = stripProviderHost(provider, repository)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  return `${providerHosts[provider]}/${path}`
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
