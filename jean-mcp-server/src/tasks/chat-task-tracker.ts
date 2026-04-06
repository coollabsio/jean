import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  RequestHandlerExtra,
  RequestTaskStore,
} from '@modelcontextprotocol/sdk/shared/protocol.js';

import { JeanMcpError, normalizeError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { JeanEvent, JeanWsClient } from '../transport/jean-ws-client.js';

interface ChatTaskContext {
  taskId: string;
  sessionId: string;
  worktreeId: string;
  worktreePath: string;
  createdAt: number;
  lastEventAt: number;
  sendResult: unknown;
  cancelForwarded: boolean;
  taskStore: RequestTaskStore;
}

type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string' && field.length > 0) return field;
  }
  return undefined;
}

export class JeanChatTaskTracker {
  private readonly activeTasks = new Map<string, ChatTaskContext>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jeanClient: JeanWsClient,
    private readonly logger: Logger,
    private readonly options: {
      taskTtlMs: number;
      taskPollIntervalMs: number;
      taskTimeoutMs: number;
    }
  ) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.options.taskPollIntervalMs);
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async startSendChatTask(
    commandArgs: Record<string, unknown>,
    extra: ToolCallExtra
  ): Promise<CallToolResult> {
    if (!extra.taskStore) {
      throw new JeanMcpError(
        'TASKS_UNAVAILABLE',
        'Task tracking was requested but task storage is unavailable.'
      );
    }

    const sessionId = this.getRequiredArg(commandArgs, 'sessionId');
    const worktreeId = this.getRequiredArg(commandArgs, 'worktreeId');
    const worktreePath = this.getRequiredArg(commandArgs, 'worktreePath');
    const taskTtlMs = extra.taskRequestedTtl ?? this.options.taskTtlMs;

    const task = await extra.taskStore.createTask({
      ttl: taskTtlMs,
      pollInterval: this.options.taskPollIntervalMs,
    });

    const context: ChatTaskContext = {
      taskId: task.taskId,
      sessionId,
      worktreeId,
      worktreePath,
      createdAt: Date.now(),
      lastEventAt: Date.now(),
      sendResult: null,
      cancelForwarded: false,
      taskStore: extra.taskStore,
    };
    this.activeTasks.set(task.taskId, context);

    await extra.taskStore.updateTaskStatus(
      task.taskId,
      'working',
      'Dispatching chat message to Jean.'
    );

    try {
      context.sendResult = await this.jeanClient.invoke('send_chat_message', commandArgs);
      context.lastEventAt = Date.now();

      await extra.taskStore.updateTaskStatus(
        task.taskId,
        'working',
        'Jean accepted message; waiting for terminal chat event.'
      );
    } catch (error) {
      this.activeTasks.delete(task.taskId);
      const normalized = normalizeError(error, 'SEND_CHAT_FAILED');
      await extra.taskStore.storeTaskResult(
        task.taskId,
        'failed',
        this.buildFailedResult(
          task.taskId,
          sessionId,
          worktreeId,
          normalized.message,
          null
        )
      );
      throw normalized;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              taskId: task.taskId,
              status: 'working',
              sessionId,
              worktreeId,
              detail: 'Use tasks/get and tasks/result to follow completion.',
            },
            null,
            2
          ),
        },
      ],
      structuredContent: {
        taskId: task.taskId,
        status: 'working',
        sessionId,
        worktreeId,
      },
    };
  }

  async handleJeanEvent(event: JeanEvent): Promise<void> {
    if (!event.event.startsWith('chat:')) {
      return;
    }

    if (!isRecord(event.payload)) {
      return;
    }

    const sessionId = getStringField(event.payload, 'session_id', 'sessionId');
    const worktreeId = getStringField(event.payload, 'worktree_id', 'worktreeId');

    if (!sessionId || !worktreeId) {
      return;
    }

    for (const context of this.activeTasks.values()) {
      if (context.sessionId !== sessionId || context.worktreeId !== worktreeId) {
        continue;
      }
      await this.applyEventToTask(context, event.event, event.payload);
    }
  }

  private async applyEventToTask(
    context: ChatTaskContext,
    eventName: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    context.lastEventAt = Date.now();

    if (eventName === 'chat:done') {
      this.activeTasks.delete(context.taskId);
      await context.taskStore.storeTaskResult(
        context.taskId,
        'completed',
        this.buildCompletedResult(context, payload)
      );
      return;
    }

    if (eventName === 'chat:error') {
      this.activeTasks.delete(context.taskId);
      const errorMessage = getStringField(payload, 'error') ?? 'Jean chat failed.';
      await context.taskStore.storeTaskResult(
        context.taskId,
        'failed',
        this.buildFailedResult(
          context.taskId,
          context.sessionId,
          context.worktreeId,
          errorMessage,
          payload
        )
      );
      return;
    }

    if (eventName === 'chat:cancelled') {
      this.activeTasks.delete(context.taskId);
      await context.taskStore.updateTaskStatus(
        context.taskId,
        'cancelled',
        'Jean chat was cancelled.'
      );
      return;
    }

    const statusMessage = this.getProgressStatusMessage(eventName, payload);
    try {
      await context.taskStore.updateTaskStatus(context.taskId, 'working', statusMessage);
    } catch (error) {
      const normalized = normalizeError(error, 'TASK_STATUS_UPDATE_FAILED');
      this.logger.warn('Ignoring failed task status update.', {
        taskId: context.taskId,
        event: eventName,
        code: normalized.code,
        message: normalized.message,
      });
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();

    for (const [taskId, context] of this.activeTasks.entries()) {
      if (now - context.lastEventAt > this.options.taskTimeoutMs) {
        this.activeTasks.delete(taskId);
        await context.taskStore.storeTaskResult(
          taskId,
          'failed',
          this.buildFailedResult(
            taskId,
            context.sessionId,
            context.worktreeId,
            `Timed out after ${this.options.taskTimeoutMs}ms waiting for Jean terminal event.`,
            null
          )
        );
        continue;
      }

      try {
        const task = await context.taskStore.getTask(taskId);

        if (task.status === 'completed' || task.status === 'failed') {
          this.activeTasks.delete(taskId);
          continue;
        }

        if (task.status === 'cancelled') {
          this.activeTasks.delete(taskId);
          if (!context.cancelForwarded) {
            context.cancelForwarded = true;
            await this.forwardCancel(context);
          }
        }
      } catch {
        this.activeTasks.delete(taskId);
      }
    }
  }

  private async forwardCancel(context: ChatTaskContext): Promise<void> {
    try {
      await this.jeanClient.invoke('cancel_chat_message', {
        sessionId: context.sessionId,
        worktreeId: context.worktreeId,
      });
    } catch (error) {
      const normalized = normalizeError(error, 'CANCEL_FORWARD_FAILED');
      this.logger.warn('Failed forwarding task cancellation to Jean.', {
        taskId: context.taskId,
        sessionId: context.sessionId,
        code: normalized.code,
        message: normalized.message,
      });
    }
  }

  private getRequiredArg(
    args: Record<string, unknown>,
    field: string
  ): string {
    const value = args[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new JeanMcpError('INVALID_ARGUMENTS', `Missing required field: ${field}`);
    }
    return value;
  }

  private getProgressStatusMessage(
    eventName: string,
    payload: Record<string, unknown>
  ): string {
    if (eventName === 'chat:sending') {
      return 'Jean is preparing response.';
    }

    if (eventName === 'chat:chunk') {
      const chunk = getStringField(payload, 'content');
      const length = chunk?.length ?? 0;
      return `Streaming response chunk (${length} chars).`;
    }

    if (eventName === 'chat:thinking') {
      return 'Jean emitted thinking step.';
    }

    if (eventName === 'chat:tool_use') {
      const toolName = getStringField(payload, 'name') ?? 'unknown tool';
      return `Jean invoked tool: ${toolName}.`;
    }

    if (eventName === 'chat:tool_result') {
      return 'Jean received tool result.';
    }

    if (eventName === 'chat:compacting') {
      return 'Jean is compacting context.';
    }

    if (eventName === 'chat:compacted') {
      return 'Jean finished context compaction.';
    }

    if (eventName === 'chat:permission_denied') {
      return 'Jean reported permission denied event.';
    }

    return `Chat progress event: ${eventName}.`;
  }

  private buildCompletedResult(
    context: ChatTaskContext,
    payload: Record<string, unknown>
  ): CallToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              taskId: context.taskId,
              status: 'completed',
              sessionId: context.sessionId,
              worktreeId: context.worktreeId,
              worktreePath: context.worktreePath,
              sendResult: context.sendResult,
              terminalEvent: payload,
            },
            null,
            2
          ),
        },
      ],
      structuredContent: {
        taskId: context.taskId,
        status: 'completed',
        sessionId: context.sessionId,
        worktreeId: context.worktreeId,
      },
    };
  }

  private buildFailedResult(
    taskId: string,
    sessionId: string,
    worktreeId: string,
    message: string,
    payload: Record<string, unknown> | null
  ): CallToolResult {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              taskId,
              status: 'failed',
              sessionId,
              worktreeId,
              error: message,
              terminalEvent: payload,
            },
            null,
            2
          ),
        },
      ],
      structuredContent: {
        taskId,
        status: 'failed',
        sessionId,
        worktreeId,
        error: message,
      },
    };
  }
}
