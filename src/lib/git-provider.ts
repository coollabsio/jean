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
