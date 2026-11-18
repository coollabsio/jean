import { githubRepoFromUrl, type GitHubRemote } from '@/services/projects'

/** A GitHub issue or pull request named by its web URL. */
export interface GitHubItemLink {
  /** `owner/name` */
  repo: string
  kind: 'issue' | 'pr'
  number: number
}

const ITEM_PATH = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/

/** Parse `https://github.com/owner/name/(issues|pull)/N[/...]`. */
export function parseGitHubItemUrl(url: string): GitHubItemLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null
  const match = ITEM_PATH.exec(parsed.pathname)
  if (!match) return null
  return {
    repo: `${match[1]}/${match[2]}`,
    kind: match[3] === 'pull' ? 'pr' : 'issue',
    number: Number(match[4]),
  }
}

/**
 * The `repo` argument for GitHub commands about `link`: undefined when the
 * link is on the primary remote (origin, else the first), the remote's
 * `owner/name` for another remote, or null when no remote points at it.
 */
export function githubLinkRepoArg(
  link: GitHubItemLink,
  remotes: GitHubRemote[]
): string | undefined | null {
  const repos = remotes.map(remote => ({
    name: remote.name,
    repo: githubRepoFromUrl(remote.url),
  }))
  const primary = repos.find(r => r.name === 'origin') ?? repos[0]
  const match = repos.find(
    r => r.repo?.toLowerCase() === link.repo.toLowerCase()
  )
  if (!match?.repo) return null
  return match === primary ? undefined : match.repo
}
