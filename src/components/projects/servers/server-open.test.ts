import { describe, expect, it } from 'vitest'
import { serverOpenCommand } from './server-open'

const local = { host: '', local: true }
const ssh = { host: '10.0.0.5', user: 'jean', port: 2222 }

describe('serverOpenCommand', () => {
  it('opens the local home directory for the Local server', () => {
    const options = { editor: 'vscode', terminal: 'ghostty', home: '/home/me' }
    expect(serverOpenCommand(local, 'editor', options)).toEqual({
      command: 'open_worktree_in_editor',
      args: { worktreePath: '/home/me', editor: 'vscode' },
    })
    expect(serverOpenCommand(local, 'terminal', options).args).toEqual({
      worktreePath: '/home/me',
      terminal: 'ghostty',
    })
    expect(serverOpenCommand(local, 'finder', options).args).toEqual({
      worktreePath: '/home/me',
    })
  })

  it('opens the remote home in Zed over SSH', () => {
    expect(
      serverOpenCommand(ssh, 'editor', { editor: 'zed', home: '' }).args
    ).toEqual({
      worktreePath: 'ssh://jean@10.0.0.5:2222/~/',
      editor: 'zed',
    })
  })

  it('opens an SSH terminal in the remote home', () => {
    expect(
      serverOpenCommand(ssh, 'terminal', { terminal: 'ghostty', home: '' }).args
    ).toEqual({
      worktreePath: '.',
      terminal: 'ghostty',
      sshUser: 'jean',
      sshHost: '10.0.0.5',
      sshPort: 2222,
    })
  })

  it('rejects Finder and non-Zed editors for SSH servers', () => {
    expect(() => serverOpenCommand(ssh, 'finder', { home: '' })).toThrow()
    expect(() =>
      serverOpenCommand(ssh, 'editor', { editor: 'vscode', home: '' })
    ).toThrow(/Only Zed/)
  })
})
