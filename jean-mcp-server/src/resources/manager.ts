import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { JeanMcpError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { JeanEvent } from '../transport/jean-ws-client.js';

type InvokeCommand = (
  command: string,
  args: Record<string, unknown>
) => Promise<unknown>;

interface ResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description: string;
}

interface ResourceTemplateDescriptor {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
}

const JSON_MIME = 'application/json';

const STATIC_RESOURCES: ResourceDescriptor[] = [
  {
    uri: 'jean://projects',
    name: 'projects',
    title: 'Jean Projects',
    description: 'List of all projects available in Jean.',
  },
  {
    uri: 'jean://sessions',
    name: 'sessions',
    title: 'Jean Sessions',
    description: 'List of all sessions across all worktrees.',
  },
  {
    uri: 'jean://saved-contexts',
    name: 'saved-contexts',
    title: 'Saved Contexts',
    description: 'Saved context file index from Jean.',
  },
  {
    uri: 'jean://skills/claude',
    name: 'claude-skills',
    title: 'Claude Skills',
    description: 'Skill definitions discoverable by Jean.',
  },
  {
    uri: 'jean://commands/claude',
    name: 'claude-commands',
    title: 'Claude Commands',
    description: 'Claude command definitions discoverable by Jean.',
  },
];

const RESOURCE_TEMPLATES: ResourceTemplateDescriptor[] = [
  {
    uriTemplate: 'jean://projects/{projectId}/worktrees',
    name: 'project-worktrees',
    title: 'Project Worktrees',
    description: 'Worktrees for a project id.',
  },
  {
    uriTemplate: 'jean://worktrees/{worktreeId}/sessions?worktreePath={worktreePath}',
    name: 'worktree-sessions',
    title: 'Worktree Sessions',
    description: 'Sessions for a worktree id/path pair.',
  },
  {
    uriTemplate:
      'jean://sessions/{sessionId}?worktreeId={worktreeId}&worktreePath={worktreePath}',
    name: 'session-detail',
    title: 'Session Detail',
    description: 'Detailed session record by session/worktree identifiers.',
  },
];

function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toReadResourceResult(uri: string, payload: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: JSON_MIME,
        text: toJsonText(payload),
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPayloadKeys(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const keys = payload.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter((value): value is string => typeof value === 'string');
}

export class JeanResourceManager {
  private readonly subscribedUris = new Set<string>();

  constructor(
    private readonly server: Server,
    private readonly invokeCommand: InvokeCommand,
    private readonly logger: Logger
  ) {}

  listResources() {
    return {
      resources: STATIC_RESOURCES.map(resource => ({
        uri: resource.uri,
        name: resource.name,
        title: resource.title,
        description: resource.description,
        mimeType: JSON_MIME,
      })),
    };
  }

  listResourceTemplates() {
    return {
      resourceTemplates: RESOURCE_TEMPLATES.map(template => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        title: template.title,
        description: template.description,
        mimeType: JSON_MIME,
      })),
    };
  }

  subscribe(uri: string) {
    this.subscribedUris.add(uri);
  }

  unsubscribe(uri: string) {
    this.subscribedUris.delete(uri);
  }

  async handleReconnect(): Promise<void> {
    try {
      await this.server.sendResourceListChanged();
    } catch (error) {
      this.logger.warn('Failed sending resources/list_changed notification.', {
        error: String(error),
      });
    }

    await this.invalidateUris(new Set(this.subscribedUris));
  }

  async handleJeanEvent(event: JeanEvent): Promise<void> {
    const dirtyUris = this.matchDirtySubscriptions(event);
    if (dirtyUris.size === 0) return;
    await this.invalidateUris(dirtyUris);
  }

  async read(uri: string): Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }> {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new JeanMcpError('INVALID_RESOURCE_URI', 'Invalid resource URI.', {
        uri,
      });
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const host = parsed.hostname;

    if (host === 'projects' && segments.length === 0) {
      const data = await this.invokeCommand('list_projects', {});
      return toReadResourceResult(uri, {
        command: 'list_projects',
        args: {},
        data,
      });
    }

    if (host === 'projects' && segments.length === 2 && segments[1] === 'worktrees') {
      const projectId = decodeURIComponent(segments[0]!);
      const data = await this.invokeCommand('list_worktrees', { projectId });
      return toReadResourceResult(uri, {
        command: 'list_worktrees',
        args: { projectId },
        data,
      });
    }

    if (host === 'sessions' && segments.length === 0) {
      const data = await this.invokeCommand('list_all_sessions', {});
      return toReadResourceResult(uri, {
        command: 'list_all_sessions',
        args: {},
        data,
      });
    }

    if (host === 'sessions' && segments.length === 1) {
      const sessionId = decodeURIComponent(segments[0]!);
      const worktreeId = parsed.searchParams.get('worktreeId') ?? undefined;
      const worktreePath = parsed.searchParams.get('worktreePath') ?? undefined;

      if (!worktreeId || !worktreePath) {
        throw new JeanMcpError(
          'INVALID_RESOURCE_URI',
          'session resource requires worktreeId and worktreePath query params.',
          { uri }
        );
      }

      const args = {
        sessionId,
        worktreeId,
        worktreePath,
      };
      const data = await this.invokeCommand('get_session', args);
      return toReadResourceResult(uri, {
        command: 'get_session',
        args,
        data,
      });
    }

    if (host === 'worktrees' && segments.length === 2 && segments[1] === 'sessions') {
      const worktreeId = decodeURIComponent(segments[0]!);
      const worktreePath = parsed.searchParams.get('worktreePath') ?? undefined;

      if (!worktreePath) {
        throw new JeanMcpError(
          'INVALID_RESOURCE_URI',
          'worktree sessions resource requires worktreePath query param.',
          { uri }
        );
      }

      const args = {
        worktreeId,
        worktreePath,
      };
      const data = await this.invokeCommand('get_sessions', args);
      return toReadResourceResult(uri, {
        command: 'get_sessions',
        args,
        data,
      });
    }

    if (host === 'saved-contexts' && segments.length === 0) {
      const data = await this.invokeCommand('list_saved_contexts', {});
      return toReadResourceResult(uri, {
        command: 'list_saved_contexts',
        args: {},
        data,
      });
    }

    if (host === 'skills' && segments.length === 1 && segments[0] === 'claude') {
      const data = await this.invokeCommand('list_claude_skills', {});
      return toReadResourceResult(uri, {
        command: 'list_claude_skills',
        args: {},
        data,
      });
    }

    if (host === 'commands' && segments.length === 1 && segments[0] === 'claude') {
      const data = await this.invokeCommand('list_claude_commands', {});
      return toReadResourceResult(uri, {
        command: 'list_claude_commands',
        args: {},
        data,
      });
    }

    throw new JeanMcpError('RESOURCE_NOT_FOUND', 'Unknown resource URI.', { uri });
  }

  private async invalidateUris(uris: Set<string>): Promise<void> {
    for (const uri of uris) {
      try {
        await this.server.sendResourceUpdated({ uri });
      } catch (error) {
        this.logger.warn('Failed sending resources/updated notification.', {
          uri,
          error: String(error),
        });
      }
    }
  }

  private matchDirtySubscriptions(event: JeanEvent): Set<string> {
    const dirtyUris = new Set<string>();
    const keys = event.event === 'cache:invalidate' ? getPayloadKeys(event.payload) : [];

    if (
      keys.includes('projects') ||
      event.event.startsWith('worktree:') ||
      event.event.startsWith('git:') ||
      event.event.startsWith('pr:')
    ) {
      this.addIfSubscribed(dirtyUris, 'jean://projects');
      this.addByPrefix(dirtyUris, 'jean://projects/');
    }

    if (
      keys.includes('sessions') ||
      event.event.startsWith('chat:') ||
      event.event.startsWith('session-')
    ) {
      this.addIfSubscribed(dirtyUris, 'jean://sessions');
      this.addByPrefix(dirtyUris, 'jean://worktrees/');
      this.addByPrefix(dirtyUris, 'jean://sessions/');
    }

    if (keys.includes('contexts')) {
      this.addIfSubscribed(dirtyUris, 'jean://saved-contexts');
    }

    return dirtyUris;
  }

  private addIfSubscribed(target: Set<string>, uri: string): void {
    if (this.subscribedUris.has(uri)) {
      target.add(uri);
    }
  }

  private addByPrefix(target: Set<string>, prefix: string): void {
    for (const subscribed of this.subscribedUris) {
      if (subscribed.startsWith(prefix)) {
        target.add(subscribed);
      }
    }
  }
}
