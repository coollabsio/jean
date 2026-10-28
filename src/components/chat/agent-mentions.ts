import type { ChatMention, ChatMentionType } from '@/types/chat'
import type { AgentSummary } from '@/services/agents'
import type { Project } from '@/types/projects'
import { isFolder } from '@/types/projects'
import { parseServerResourceKey } from '@/lib/server-resource'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/**
 * `@` mentions in agent chats. An agent chat does not run inside a project,
 * so `@` picks agents, remote Jeans, and projects instead of files.
 *
 * The composer text is the only state: selecting an item inserts `@token`.
 * At send time `resolveMentions` finds the tokens that are still in the text
 * and turns them into structured mentions (type + server-side ID).
 * `formatMentionRefs` then adds one context line per mention to the prompt,
 * like the `[File: ...]` lines for file mentions. Keep the line format in
 * sync with `mention_ref` in jean-core/src/chat/commands.rs.
 */

/** A selectable mention plus what the picker needs to show it. */
export interface MentionCandidate extends ChatMention {
  /** Text after `@` in the composer. Unique within one candidate list. */
  token: string
  /** Agent color key (agents only) */
  icon?: string
  /** Project avatar URL (projects only) */
  avatarUrl?: string | null
}

export const MENTION_GROUPS: { type: ChatMentionType; heading: string }[] = [
  { type: 'agent', heading: 'Agents' },
  { type: 'remote_jean', heading: 'Remote Jeans' },
  { type: 'project', heading: 'Projects' },
]

/** `@` token for a display name: whitespace becomes `-`. */
export function mentionToken(name: string): string {
  return name.trim().replace(/\s+/g, '-') || 'item'
}

/**
 * Give each candidate a unique token. Earlier candidates keep the plain
 * name, so put the most likely targets (agents) first.
 */
export function withUniqueTokens(
  mentions: Omit<MentionCandidate, 'token'>[]
): MentionCandidate[] {
  const used = new Set<string>()
  return mentions.map(mention => {
    const base = mentionToken(mention.name)
    let token = base
    for (let n = 2; used.has(token.toLowerCase()); n++) token = `${base}-${n}`
    used.add(token.toLowerCase())
    return { ...mention, token }
  })
}

/** ID of a resource on its own server (strips the `serverId:` client scope). */
function serverSideId(id: string, serverId: string): string {
  if (serverId === LOCAL_SERVER_ID) return id
  return parseServerResourceKey(id)?.resourceId ?? id
}

/**
 * All mention candidates for an agent chat on `chatServerId`, agents first.
 * Items on another Jean carry that Jean's name so the agent knows where they
 * are.
 */
export function buildMentionCandidates({
  chatServerId,
  agents,
  remoteJeans,
  projects,
  projectAvatar,
}: {
  chatServerId: string
  agents: AgentSummary[]
  remoteJeans: { id: string; name: string; url: string }[]
  projects: Project[]
  projectAvatar?: (project: Project) => string | null
}): MentionCandidate[] {
  const otherServer = (serverId: string, serverName: string | undefined) =>
    serverId === chatServerId ? {} : { serverName: serverName ?? 'Local' }

  return withUniqueTokens([
    ...agents.map(agent => ({
      type: 'agent' as const,
      id: serverSideId(agent.id, agent.serverId),
      name: agent.name,
      icon: agent.icon,
      ...otherServer(agent.serverId, agent.serverName),
    })),
    ...remoteJeans
      .filter(jean => jean.id !== chatServerId)
      .map(jean => ({
        type: 'remote_jean' as const,
        id: jean.id,
        name: jean.name,
        url: jean.url,
      })),
    ...projects
      // Server entries (`project.server`) are machines, not projects
      .filter(project => !isFolder(project) && !project.server)
      .map(project => {
        const serverId = project.serverId ?? LOCAL_SERVER_ID
        return {
          type: 'project' as const,
          id: project.resourceId ?? serverSideId(project.id, serverId),
          name: project.name,
          avatarUrl: projectAvatar?.(project) ?? null,
          ...otherServer(serverId, project.serverName),
        }
      }),
  ])
}

/** Candidates that match the text typed after `@`, per group in order. */
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
  limitPerGroup = 8
): MentionCandidate[] {
  const q = query.trim().toLowerCase()
  const score = (c: MentionCandidate) => {
    if (!q) return 0
    const name = c.name.toLowerCase()
    const token = c.token.toLowerCase()
    if (name.startsWith(q) || token.startsWith(q)) return 0
    if (name.includes(q) || token.includes(q)) return 1
    return -1
  }
  return MENTION_GROUPS.flatMap(({ type }) =>
    candidates
      .filter(c => c.type === type && score(c) >= 0)
      .sort((a, b) => score(a) - score(b))
      .slice(0, limitPerGroup)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Mentions whose `@token` is in the text, in text order, without duplicates. */
export function resolveMentions(
  text: string,
  candidates: MentionCandidate[]
): ChatMention[] {
  const found: { index: number; mention: ChatMention }[] = []
  for (const candidate of candidates) {
    const pattern = new RegExp(
      `(^|\\s)@${escapeRegExp(candidate.token)}(?=$|[\\s.,;:!?)])`
    )
    const match = pattern.exec(text)
    if (!match) continue
    const { type, id, name, serverName, url } = candidate
    found.push({
      index: match.index,
      mention: {
        type,
        id,
        name,
        ...(serverName ? { serverName } : {}),
        ...(url ? { url } : {}),
      },
    })
  }
  return found.sort((a, b) => a.index - b.index).map(f => f.mention)
}

const ID_LABEL: Record<ChatMentionType, string> = {
  agent: 'agentId',
  project: 'projectId',
  remote_jean: 'serverId',
}

const TYPE_LABEL: Record<ChatMentionType, string> = {
  agent: 'agent',
  project: 'project',
  remote_jean: 'remote Jean',
}

/** One prompt line for a mention. */
export function mentionRef(mention: ChatMention): string {
  const details = [`${ID_LABEL[mention.type]}: ${mention.id}`]
  if (mention.serverName) details.push(`on remote Jean: ${mention.serverName}`)
  if (mention.url) details.push(`url: ${mention.url}`)
  return `[Mentioned ${TYPE_LABEL[mention.type]}: ${mention.name} (${details.join(', ')})]`
}

/** Context block for the prompt, or '' when there are no mentions. */
export function formatMentionRefs(mentions: ChatMention[] | undefined): string {
  return (mentions ?? []).map(mentionRef).join('\n')
}

const MENTION_REF_REGEX =
  /\[Mentioned (?:agent|project|remote Jean): .+? \((?:agentId|projectId|serverId): [^\]]*\)\]/g

/** Remove mention context lines from content for display. */
export function stripMentionRefs(content: string): string {
  return content.replace(MENTION_REF_REGEX, '').trim()
}
