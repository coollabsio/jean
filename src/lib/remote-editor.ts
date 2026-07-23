import type { RemoteConnection } from './remote-connections'

export interface RemoteSshEndpoint {
  user?: string
  host: string
  /** Undefined or 22 means default SSH port. */
  port?: number
}

/**
 * Resolve SSH connection details for opening remote filesystem paths in a
 * local editor CLI (Zed: `zed ssh://user@host/path`).
 *
 * Prefers explicit SSH fields on the connection; falls back to the Web Access
 * URL hostname when `sshHost` is unset.
 */
export function resolveRemoteSshEndpoint(
  connection: RemoteConnection
): RemoteSshEndpoint | null {
  const explicitHost = connection.sshHost?.trim()
  let host = explicitHost || ''
  if (!host) {
    try {
      host = new URL(connection.url).hostname
    } catch {
      host = ''
    }
  }
  if (!host) return null

  const user = connection.sshUser?.trim() || undefined
  const port =
    typeof connection.sshPort === 'number' &&
    Number.isInteger(connection.sshPort) &&
    connection.sshPort > 0 &&
    connection.sshPort <= 65535
      ? connection.sshPort
      : undefined

  return { user, host, port }
}

/**
 * Build a Zed remote SSH target: `ssh://[user@]host[:port]/path`.
 *
 * Line/column are left to the local desktop command (`path:line:column`) so
 * callers should pass the bare remote filesystem path here.
 */
export function buildZedSshTarget(options: {
  path: string
  user?: string
  host: string
  port?: number
}): string {
  const host = options.host.trim()
  if (!host) {
    throw new Error('SSH host is required to open a remote path in Zed.')
  }

  const path = options.path.trim()
  if (!path) {
    throw new Error('No path to open.')
  }

  // Already a Zed/ssh remote target — pass through.
  if (path.startsWith('ssh://')) {
    return path
  }

  const user = options.user?.trim()
  const authority = user ? `${user}@${host}` : host
  const portSuffix =
    options.port && options.port !== 22 ? `:${options.port}` : ''

  // Zed accepts absolute paths (`/home/...`) and home-relative (`~/...`).
  // Both must appear after the authority with a leading slash in the URL.
  let pathPart: string
  if (path.startsWith('~/')) {
    pathPart = `/${path}`
  } else if (path.startsWith('/')) {
    pathPart = path
  } else {
    pathPart = `/${path}`
  }

  return `ssh://${authority}${portSuffix}${pathPart}`
}

const REMOTE_EDITOR_COMMANDS = new Set([
  'open_worktree_in_editor',
  'open_file_in_default_app',
])

/**
 * When the native app is pointed at a remote Jean, rewrite editor-open
 * commands so the local `zed` CLI receives an `ssh://…` target.
 *
 * Returns null when the command is not an editor-open call (caller continues
 * normal transport routing). Throws when open is requested but cannot be
 * remapped (unsupported editor, missing SSH config).
 */
export function prepareRemoteEditorOpenArgs(
  command: string,
  args: Record<string, unknown> | undefined,
  connection: RemoteConnection
): Record<string, unknown> | null {
  if (!REMOTE_EDITOR_COMMANDS.has(command)) return null

  const editor =
    typeof args?.editor === 'string' && args.editor.trim()
      ? args.editor.trim()
      : 'zed'

  if (editor !== 'zed') {
    throw new Error(
      `Opening ${editor} on a remote Jean host is not supported yet. Set your editor preference to Zed (uses \`zed ssh://…\`), or open the remote path in that editor via SSH yourself.`
    )
  }

  const rawPath =
    command === 'open_worktree_in_editor'
      ? args?.worktreePath
      : args?.path
  const path = typeof rawPath === 'string' ? rawPath : ''
  if (!path.trim()) {
    throw new Error('No path to open.')
  }

  const endpoint = resolveRemoteSshEndpoint(connection)
  if (!endpoint) {
    throw new Error(
      'Configure SSH user and host on this remote connection to open paths in Zed.'
    )
  }

  // Prefer an explicit SSH user when present; host-only still works if the
  // local SSH config maps the host to a user.
  const target = buildZedSshTarget({
    path,
    user: endpoint.user,
    host: endpoint.host,
    port: endpoint.port,
  })

  if (command === 'open_worktree_in_editor') {
    return { worktreePath: target, editor: 'zed' }
  }

  return {
    path: target,
    editor: 'zed',
    line: args?.line,
    column: args?.column,
  }
}
