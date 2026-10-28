import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '@/services/agents'
import type { Project } from '@/types/projects'
import {
  buildMentionCandidates,
  filterMentionCandidates,
  resolveMentions,
  stripMentionRefs,
  withUniqueTokens,
  type MentionCandidate,
} from './agent-mentions'
import { stripAllMarkers } from './message-content-utils'

const agent = (over: Partial<AgentSummary>) =>
  ({
    id: 'jean',
    serverId: 'local',
    serverName: 'Local',
    name: 'Jean',
    icon: 'jean',
    ...over,
  }) as AgentSummary

const project = (over: Partial<Project>) =>
  ({ id: 'p1', name: 'coolify', path: '/p', ...over }) as Project

describe('buildMentionCandidates', () => {
  it('lists agents, remote Jeans, and projects with server-side IDs', () => {
    const candidates = buildMentionCandidates({
      chatServerId: 'local',
      agents: [
        agent({}),
        agent({
          id: 'srv-1:rev',
          serverId: 'srv-1',
          serverName: 'Home',
          name: 'Code Reviewer',
          icon: 'blue',
        }),
      ],
      remoteJeans: [{ id: 'srv-1', name: 'Home', url: 'https://home' }],
      projects: [
        project({}),
        project({
          id: 'srv-1:p2',
          resourceId: 'p2',
          serverId: 'srv-1',
          serverName: 'Home',
          name: 'docs',
        }),
        project({ id: 'f', name: 'Folder', is_folder: true }),
        project({ id: 's', name: 'box', server: {} as Project['server'] }),
      ],
    })

    expect(
      candidates.map(({ type, id, token, serverName }) => ({
        type,
        id,
        token,
        serverName,
      }))
    ).toEqual([
      { type: 'agent', id: 'jean', token: 'Jean', serverName: undefined },
      {
        type: 'agent',
        id: 'rev',
        token: 'Code-Reviewer',
        serverName: 'Home',
      },
      {
        type: 'remote_jean',
        id: 'srv-1',
        token: 'Home',
        serverName: undefined,
      },
      { type: 'project', id: 'p1', token: 'coolify', serverName: undefined },
      { type: 'project', id: 'p2', token: 'docs', serverName: 'Home' },
    ])
  })

  it('names the local Jean for items when the chat runs on a remote Jean', () => {
    const [jean, home] = buildMentionCandidates({
      chatServerId: 'srv-1',
      agents: [agent({})],
      remoteJeans: [{ id: 'srv-1', name: 'Home', url: 'https://home' }],
      projects: [],
    })
    expect(jean?.serverName).toBe('Local')
    // The chat's own Jean is not offered as a remote Jean
    expect(home).toBeUndefined()
  })
})

describe('withUniqueTokens', () => {
  it('keeps the first name and numbers later duplicates', () => {
    const tokens = withUniqueTokens([
      { type: 'agent', id: 'a', name: 'Jean' },
      { type: 'project', id: 'b', name: 'jean' },
      { type: 'project', id: 'c', name: 'Jean' },
    ]).map(c => c.token)
    expect(tokens).toEqual(['Jean', 'jean-2', 'Jean-3'])
  })
})

const candidates: MentionCandidate[] = withUniqueTokens([
  { type: 'project', id: 'p1', name: 'coolify' },
  { type: 'agent', id: 'jean', name: 'Jean' },
  { type: 'agent', id: 'rev', name: 'Code Reviewer' },
  { type: 'remote_jean', id: 'srv-1', name: 'home', url: 'https://home' },
])

describe('filterMentionCandidates', () => {
  it('orders by group, then prefix matches before substring matches', () => {
    expect(filterMentionCandidates(candidates, '').map(c => c.id)).toEqual([
      'jean',
      'rev',
      'srv-1',
      'p1',
    ])
    expect(filterMentionCandidates(candidates, 'co').map(c => c.id)).toEqual(
      ['rev', 'p1']
    )
    expect(filterMentionCandidates(candidates, 'view').map(c => c.id)).toEqual(
      ['rev']
    )
  })
})

describe('resolveMentions', () => {
  it('returns mentions in text order without the UI-only fields', () => {
    expect(
      resolveMentions('Ask @Code-Reviewer, then deploy @coolify.', candidates)
    ).toEqual([
      { type: 'agent', id: 'rev', name: 'Code Reviewer' },
      { type: 'project', id: 'p1', name: 'coolify' },
    ])
  })

  it('ignores tokens that are only a prefix, or inside other words', () => {
    expect(
      resolveMentions('mail@Jean and @Jeanette and @coolify2', candidates)
    ).toEqual([])
  })

  it('keeps the remote Jean URL', () => {
    expect(resolveMentions('@home', candidates)).toEqual([
      { type: 'remote_jean', id: 'srv-1', name: 'home', url: 'https://home' },
    ])
  })
})

describe('stripMentionRefs', () => {
  it('removes mention context lines from displayed messages', () => {
    const content =
      'Ask @Jean\n\n[Mentioned agent: Jean (agentId: jean)]\n[Mentioned remote Jean: home (serverId: srv-1, url: https://home)]'
    expect(stripMentionRefs(content)).toBe('Ask @Jean')
    expect(stripAllMarkers(content)).toBe('Ask @Jean')
  })
})
