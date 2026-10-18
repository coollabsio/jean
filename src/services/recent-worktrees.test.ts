import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RecentWorktreesResponse } from '@/types/projects'
import { fetchRecentWorktrees } from './projects'

const invokeForServer = vi.hoisted(() => vi.fn())
vi.mock('@/lib/transport', async importOriginal => ({
  ...(await importOriginal()),
  invokeForServer,
}))

const project = (id: string, serverId?: string): Project =>
  ({
    id: serverId ? `${serverId}:${id}` : id,
    resourceId: serverId ? id : undefined,
    serverId,
    name: id,
    path: `/${id}`,
    default_branch: 'main',
    added_at: 1,
    order: 0,
  }) as Project

const response = (
  serverId: string,
  id: string,
  activity: number,
  total = 1
): RecentWorktreesResponse => ({
  total,
  failedWorktreeIds: [],
  items: [
    {
      projectId: `${serverId}:${id}`,
      projectName: id,
      lastActivityAt: activity,
      added: 1,
      removed: 2,
      worktree: {
        id: `${serverId}:wt-${id}`,
        project_id: `${serverId}:${id}`,
        name: `wt-${id}`,
        path: `/wt-${id}`,
        branch: id,
        created_at: activity,
        order: 0,
      },
      session: {
        id: `${serverId}:session-${id}`,
        name: id,
        order: 0,
        created_at: activity,
        updated_at: activity,
        messages: [],
      },
    },
  ],
})

describe('fetchRecentWorktrees', () => {
  beforeEach(() => invokeForServer.mockReset())

  it('does not mix automation sessions into Recent, even from older servers or pinned rows', async () => {
    const normal = response('local', 'normal', 10)
    const robot = response('local', 'robot', 20)
    const robotItem = robot.items[0]
    if (!robotItem) throw new Error('Missing robot fixture')
    robotItem.worktree.origin = 'auto_fix'
    invokeForServer.mockResolvedValue({
      items: [...robot.items, ...normal.items],
      total: 2,
      failedWorktreeIds: [],
    })
    const result = await fetchRecentWorktrees([project('normal')], 10, [
      robotItem.session.id,
    ])
    expect(result.items.map(item => item.projectName)).toEqual(['normal'])
  })

  it('queries once per server and merges rows by activity', async () => {
    invokeForServer.mockImplementation((serverId: string) =>
      Promise.resolve(
        serverId === 'remote'
          ? response('remote', 'remote-project', 20)
          : response('local', 'local-project', 10)
      )
    )

    const result = await fetchRecentWorktrees(
      [project('local-project'), project('remote-project', 'remote')],
      10,
      []
    )

    expect(invokeForServer).toHaveBeenCalledTimes(2)
    expect(result.items.map(item => item.projectName)).toEqual([
      'remote-project',
      'local-project',
    ])
  })

  it('keeps successful server rows when another server fails', async () => {
    invokeForServer.mockImplementation((serverId: string) =>
      serverId === 'remote'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(response('local', 'local-project', 10))
    )

    const result = await fetchRecentWorktrees(
      [project('local-project'), project('remote-project', 'remote')],
      10,
      []
    )

    expect(result.items).toHaveLength(1)
    expect(result.failedServerIds).toEqual(['remote'])
  })

  it('keeps separate recent sessions from the same worktree', async () => {
    const data = response('local', 'project', 20, 2)
    const first = data.items[0]
    expect(first).toBeDefined()
    if (!first) return
    data.items.push({
      ...first,
      lastActivityAt: 10,
      session: { ...first.session, id: 'session-older', name: 'Older session' },
    })
    invokeForServer.mockResolvedValue(data)

    const result = await fetchRecentWorktrees([project('project')], 10, [])

    expect(result.items.map(item => item.session.name)).toEqual([
      'project',
      'Older session',
    ])
  })

  it('keeps pinned sessions beyond the recent page without duplicates', async () => {
    const data = response('local', 'project', 30, 12)
    const newest = data.items[0]
    expect(newest).toBeDefined()
    if (!newest) return
    data.items = [
      newest,
      {
        ...newest,
        lastActivityAt: 20,
        session: { ...newest.session, id: 'local:pinned-old' },
      },
      {
        ...newest,
        lastActivityAt: 10,
        session: { ...newest.session, id: 'local:pinned-older' },
      },
    ]
    invokeForServer.mockResolvedValue(data)

    const result = await fetchRecentWorktrees([project('project')], 1, [
      'local:session-project',
      'local:pinned-old',
      'local:pinned-older',
    ])

    expect(invokeForServer).toHaveBeenCalledWith(
      'local',
      'get_recent_worktrees',
      expect.objectContaining({
        limit: 1,
        includeSessionIds: ['session-project', 'pinned-old', 'pinned-older'],
      })
    )
    expect(result.items.map(item => item.session.id)).toEqual([
      'local:session-project',
      'local:pinned-old',
      'local:pinned-older',
    ])
    expect(result.total).toBe(12)
  })

  it('sends pinned IDs only to their owning server', async () => {
    invokeForServer.mockImplementation((serverId: string) =>
      Promise.resolve(response(serverId, serverId, 10))
    )

    await fetchRecentWorktrees(
      [project('local'), project('remote', 'remote')],
      10,
      ['local:local-pin', 'remote:remote-pin']
    )

    expect(invokeForServer).toHaveBeenCalledWith(
      'local',
      'get_recent_worktrees',
      expect.objectContaining({ includeSessionIds: ['local-pin'] })
    )
    expect(invokeForServer).toHaveBeenCalledWith(
      'remote',
      'get_recent_worktrees',
      expect.objectContaining({ includeSessionIds: ['remote-pin'] })
    )
  })
})
