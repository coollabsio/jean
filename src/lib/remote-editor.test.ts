import { describe, expect, it } from 'vitest'
import {
  buildZedSshTarget,
  prepareRemoteEditorOpenArgs,
  resolveRemoteSshEndpoint,
} from './remote-editor'
import type { RemoteConnection } from './remote-connections'

const baseConnection = (
  overrides: Partial<RemoteConnection> = {}
): RemoteConnection => ({
  id: 'r1',
  name: 'Build',
  url: 'https://jean.example.com:3456',
  token: 'tok',
  ...overrides,
})

describe('resolveRemoteSshEndpoint', () => {
  it('uses explicit SSH fields when set', () => {
    expect(
      resolveRemoteSshEndpoint(
        baseConnection({
          sshUser: 'ubuntu',
          sshHost: '192.168.1.50',
          sshPort: 2222,
        })
      )
    ).toEqual({ user: 'ubuntu', host: '192.168.1.50', port: 2222 })
  })

  it('falls back to the Web Access hostname', () => {
    expect(resolveRemoteSshEndpoint(baseConnection())).toEqual({
      user: undefined,
      host: 'jean.example.com',
      port: undefined,
    })
  })

  it('returns null when no host can be resolved', () => {
    expect(
      resolveRemoteSshEndpoint(
        baseConnection({ url: 'not-a-url', sshHost: '' })
      )
    ).toBeNull()
  })
})

describe('buildZedSshTarget', () => {
  it('builds user@host absolute path targets', () => {
    expect(
      buildZedSshTarget({
        path: '/home/ubuntu/jean/app/feature',
        user: 'ubuntu',
        host: '192.168.1.50',
      })
    ).toBe('ssh://ubuntu@192.168.1.50/home/ubuntu/jean/app/feature')
  })

  it('includes non-default SSH ports', () => {
    expect(
      buildZedSshTarget({
        path: '/tmp/x',
        user: 'dev',
        host: 'box',
        port: 2222,
      })
    ).toBe('ssh://dev@box:2222/tmp/x')
  })

  it('supports home-relative paths and host-only authority', () => {
    expect(
      buildZedSshTarget({ path: '~/project', host: 'devbox' })
    ).toBe('ssh://devbox/~/project')
  })

  it('passes through existing ssh:// targets', () => {
    const existing = 'ssh://u@h/tmp/file'
    expect(buildZedSshTarget({ path: existing, host: 'ignored' })).toBe(
      existing
    )
  })
})

describe('prepareRemoteEditorOpenArgs', () => {
  const connection = baseConnection({
    sshUser: 'ubuntu',
    sshHost: '192.168.1.50',
  })

  it('returns null for unrelated commands', () => {
    expect(
      prepareRemoteEditorOpenArgs('list_projects', {}, connection)
    ).toBeNull()
  })

  it('rewrites open_worktree_in_editor for Zed', () => {
    expect(
      prepareRemoteEditorOpenArgs(
        'open_worktree_in_editor',
        {
          worktreePath: '/home/ubuntu/jean/app/feature',
          editor: 'zed',
        },
        connection
      )
    ).toEqual({
      worktreePath: 'ssh://ubuntu@192.168.1.50/home/ubuntu/jean/app/feature',
      editor: 'zed',
    })
  })

  it('defaults editor to zed and preserves line/column for files', () => {
    expect(
      prepareRemoteEditorOpenArgs(
        'open_file_in_default_app',
        {
          path: '/home/ubuntu/app/src/main.ts',
          line: 12,
          column: 4,
        },
        connection
      )
    ).toEqual({
      path: 'ssh://ubuntu@192.168.1.50/home/ubuntu/app/src/main.ts',
      editor: 'zed',
      line: 12,
      column: 4,
    })
  })

  it('rejects non-Zed editors on remote', () => {
    expect(() =>
      prepareRemoteEditorOpenArgs(
        'open_worktree_in_editor',
        { worktreePath: '/tmp', editor: 'vscode' },
        connection
      )
    ).toThrow(/Zed/)
  })

  it('errors when SSH host cannot be resolved', () => {
    expect(() =>
      prepareRemoteEditorOpenArgs(
        'open_worktree_in_editor',
        { worktreePath: '/tmp', editor: 'zed' },
        baseConnection({ url: 'bad', sshHost: undefined })
      )
    ).toThrow(/SSH/)
  })
})
