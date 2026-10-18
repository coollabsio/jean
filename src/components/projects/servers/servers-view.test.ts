import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/projects'
import {
  jeansWithoutLocalEntry,
  legacyConnectionCopies,
  serverProjectsForView,
} from './servers-view'

const project = (overrides: Partial<Project>) =>
  ({
    id: 'p',
    name: 'p',
    path: '',
    default_branch: '',
    added_at: 0,
    order: 0,
    ...overrides,
  }) as Project

const thisComputer = project({ id: 'local', server: { host: '', local: true } })
const remoteJean = project({
  id: 'r:local',
  serverId: 'r',
  server: { host: '', local: true },
})
const sshHere = project({ id: 'ssh', server: { host: '10.0.0.5' } })
const sshOnRemote = project({
  id: 'r:ssh',
  serverId: 'r',
  server: { host: '10.0.0.6' },
})
const copy = project({
  id: 'copy',
  server: { host: '10.0.0.7', jean_connection_id: 'r' },
})
const repo = project({ id: 'repo' })

describe('serverProjectsForView', () => {
  it('lists every Jean machine first, then SSH servers of all Jeans', () => {
    expect(
      serverProjectsForView([
        sshOnRemote,
        repo,
        copy,
        sshHere,
        remoteJean,
        thisComputer,
      ]).map(p => p.id)
    ).toEqual(['local', 'r:local', 'r:ssh', 'ssh'])
  })
})

describe('legacyConnectionCopies', () => {
  it('returns only copies stored by this Jean', () => {
    const remoteCopy = project({
      id: 'r:copy',
      serverId: 'r',
      server: { host: 'x', jean_connection_id: 'y' },
    })
    expect(
      legacyConnectionCopies([copy, remoteCopy, sshHere]).map(p => p.id)
    ).toEqual(['copy'])
  })
})

describe('jeansWithoutLocalEntry', () => {
  it('returns Jeans that still need their local entry', () => {
    expect(
      jeansWithoutLocalEntry(['local', 'r', 's'], [thisComputer, remoteJean])
    ).toEqual(['s'])
  })
})
