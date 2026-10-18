import { toast } from 'sonner'
import { invoke, invokeForServer } from '@/lib/transport'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { buildZedSshTarget } from '@/lib/remote-editor'
import type { ProjectServer } from '@/types/projects'

export type ServerOpenTarget = 'editor' | 'terminal' | 'finder'

/** Finder can only browse this computer: not SSH servers or other Jeans. */
export function canOpenServerInFinder(
  server: ProjectServer,
  ownerServerId: string = LOCAL_SERVER_ID
): boolean {
  return !!server.local && ownerServerId === LOCAL_SERVER_ID
}

/**
 * Command for "Open in …" on a server. Servers have no useful worktree
 * folder (only a scratch folder), so open the home directory instead:
 * the local home for Local, the remote home over SSH for other servers.
 */
export function serverOpenCommand(
  server: ProjectServer,
  target: ServerOpenTarget,
  options: { editor?: string; terminal?: string; home: string }
): { command: string; args: Record<string, unknown> } {
  if (server.local) {
    if (target === 'finder') {
      return {
        command: 'open_worktree_in_finder',
        args: { worktreePath: options.home },
      }
    }
    return target === 'terminal'
      ? {
          command: 'open_worktree_in_terminal',
          args: { worktreePath: options.home, terminal: options.terminal },
        }
      : {
          command: 'open_worktree_in_editor',
          args: { worktreePath: options.home, editor: options.editor },
        }
  }

  if (target === 'finder') {
    throw new Error('Finder cannot open a remote server.')
  }
  if (target === 'terminal') {
    return {
      command: 'open_worktree_in_terminal',
      // The SSH login starts in the remote home; "." keeps it there.
      args: {
        worktreePath: '.',
        terminal: options.terminal,
        sshUser: server.user ?? undefined,
        sshHost: server.host,
        sshPort: server.port ?? undefined,
        sshIdentityFile: server.identity_file ?? undefined,
      },
    }
  }
  const editor = options.editor ?? 'zed'
  if (editor !== 'zed') {
    throw new Error(
      'Only Zed can open a remote server (zed ssh://…). Set your editor to Zed, or use the terminal.'
    )
  }
  return {
    command: 'open_worktree_in_editor',
    args: {
      worktreePath: buildZedSshTarget({
        path: '~/',
        user: server.user ?? undefined,
        host: server.host,
        port: server.port ?? undefined,
      }),
      editor: 'zed',
    },
  }
}

/**
 * Open a server home directory in the editor, terminal or file manager.
 * `ownerServerId` is the Jean that stores the server. Another Jean's own
 * machine opens through that Jean's connection (Zed `ssh://`, SSH terminal).
 */
export async function openServerIn(
  server: ProjectServer,
  target: ServerOpenTarget,
  options: { editor?: string; terminal?: string },
  ownerServerId: string = LOCAL_SERVER_ID
): Promise<void> {
  try {
    if (server.local && ownerServerId !== LOCAL_SERVER_ID) {
      if (target === 'finder') {
        throw new Error('Finder cannot open another Jean machine.')
      }
      await invokeForServer(
        ownerServerId,
        target === 'terminal'
          ? 'open_worktree_in_terminal'
          : 'open_worktree_in_editor',
        target === 'terminal'
          ? { worktreePath: '.', terminal: options.terminal }
          : { worktreePath: '~/', editor: options.editor }
      )
      return
    }
    const home = server.local
      ? await import('@tauri-apps/api/path').then(({ homeDir }) => homeDir())
      : ''
    // The key path belongs to the Jean that stores the server.
    const localServer =
      ownerServerId === LOCAL_SERVER_ID
        ? server
        : { ...server, identity_file: null }
    const { command, args } = serverOpenCommand(localServer, target, {
      ...options,
      home,
    })
    await invoke(command, args)
  } catch (error) {
    toast.error('Failed to open server', {
      description: error instanceof Error ? error.message : String(error),
    })
  }
}
