import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@/lib/transport', () => ({
  invoke: invokeMock,
}))

import {
  deleteSavedContextFile,
  listSavedContexts,
  readSavedContextFile,
  renameSavedContext,
  savedContextsQueryKey,
} from './saved-contexts'

describe('saved context server routing', () => {
  beforeEach(() => invokeMock.mockReset())

  it('scopes the saved-context cache to its owning project', () => {
    expect(savedContextsQueryKey('remote-1:project-1')).toEqual([
      'session-context',
      'remote-1:project-1',
    ])
  })

  it('routes context commands with the owning project id', async () => {
    invokeMock.mockResolvedValue(undefined)

    await listSavedContexts('remote-1:project-1')
    await readSavedContextFile('/remote/context.md', 'remote-1:project-1')
    await deleteSavedContextFile('/remote/context.md', 'remote-1:project-1')
    await renameSavedContext('context.md', 'New name', 'remote-1:project-1')

    expect(invokeMock.mock.calls).toEqual([
      ['list_saved_contexts', { projectId: 'remote-1:project-1' }],
      [
        'read_context_file',
        { path: '/remote/context.md', projectId: 'remote-1:project-1' },
      ],
      [
        'delete_context_file',
        { path: '/remote/context.md', projectId: 'remote-1:project-1' },
      ],
      [
        'rename_saved_context',
        {
          filename: 'context.md',
          newName: 'New name',
          projectId: 'remote-1:project-1',
        },
      ],
    ])
  })
})
