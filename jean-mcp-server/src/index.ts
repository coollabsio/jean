import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { loadConfig } from './config.js';
import { JeanResourceManager } from './resources/manager.js';
import { JeanChatTaskTracker } from './tasks/chat-task-tracker.js';
import { allTools, toolMap } from './tools/index.js';
import { JeanWsClient } from './transport/jean-ws-client.js';
import { JeanMcpError, normalizeError, toolError, toolSuccess } from './utils/errors.js';
import { Logger } from './utils/logger.js';

const SERVER_NAME = 'jean-mcp-server';
const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel, SERVER_NAME);
  const transportLogger = logger.child('transport');
  const resourcesLogger = logger.child('resources');
  const tasksLogger = logger.child('tasks');
  const taskStore = new InMemoryTaskStore();

  const jeanClient = new JeanWsClient(config, transportLogger);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {
          subscribe: true,
          listChanged: true,
        },
        tasks: {
          list: {},
          cancel: {},
          requests: {
            tools: {
              call: {},
            },
          },
        },
      },
      taskStore,
    }
  );

  const invokeJeanCommand = async (
    command: string,
    args: Record<string, unknown>
  ) => {
    return jeanClient.invoke(command, args);
  };

  const resourceManager = new JeanResourceManager(
    server,
    invokeJeanCommand,
    resourcesLogger
  );

  const chatTaskTracker = new JeanChatTaskTracker(jeanClient, tasksLogger, {
    taskTtlMs: config.chatTaskTtlMs,
    taskPollIntervalMs: config.chatTaskPollIntervalMs,
    taskTimeoutMs: config.chatTaskTimeoutMs,
  });
  chatTaskTracker.start();

  let mcpConnected = false;

  jeanClient.onEvent(event => {
    transportLogger.debug('Jean event received.', { event: event.event });
    void chatTaskTracker.handleJeanEvent(event);
    void resourceManager.handleJeanEvent(event);
  });

  jeanClient.onConnection(event => {
    if (event.state === 'connected') {
      logger.info('Jean websocket connected.', {
        reconnectAttempt: event.reconnectAttempt,
      });
      if (mcpConnected) {
        void resourceManager.handleReconnect();
      }
      return;
    }

    logger.warn('Jean websocket disconnected.', {
      reconnectAttempt: event.reconnectAttempt,
      code: event.code,
      reason: event.reason,
    });
  });

  try {
    await jeanClient.start();
  } catch (error) {
    const normalized = normalizeError(error, 'INITIAL_CONNECT_FAILED');
    logger.warn('Initial Jean connection failed; will retry on demand.', {
      code: normalized.code,
      message: normalized.message,
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
      execution: tool.execution,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const tool = toolMap.get(toolName);

    if (!tool) {
      return toolError(
        new JeanMcpError('UNKNOWN_TOOL', `Unknown tool: ${toolName}`)
      );
    }

    try {
      const parsedArgs = tool.inputSchema.parse(request.params.arguments ?? {});
      const commandArgs = tool.toCommandArgs
        ? tool.toCommandArgs(parsedArgs)
        : (parsedArgs as Record<string, unknown>);

      if (
        tool.name === 'jean_send_chat_message' &&
        request.params.task &&
        extra.taskStore
      ) {
        return await chatTaskTracker.startSendChatTask(commandArgs, extra);
      }

      const result = await invokeJeanCommand(tool.command, commandArgs);
      return toolSuccess({
        tool: tool.name,
        command: tool.command,
        result,
      });
    } catch (error) {
      return toolError(error);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return resourceManager.listResources();
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return resourceManager.listResourceTemplates();
  });

  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    return resourceManager.read(request.params.uri);
  });

  server.setRequestHandler(SubscribeRequestSchema, async request => {
    resourceManager.subscribe(request.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async request => {
    resourceManager.unsubscribe(request.params.uri);
    return {};
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    chatTaskTracker.stop();
    taskStore.cleanup();
    await jeanClient.stop();
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  mcpConnected = true;

  logger.info('MCP server ready (stdio).', {
    tools: allTools.map(tool => tool.name),
    resources: resourceManager
      .listResources()
      .resources.map(resource => resource.uri),
    jeanBaseUrl: config.jeanBaseUrl,
  });
}

main().catch(error => {
  const normalized = normalizeError(error, 'BOOT_FAILED');
  const logger = new Logger('error', SERVER_NAME);
  logger.error('Fatal startup error.', {
    code: normalized.code,
    message: normalized.message,
    details: normalized.details ?? null,
  });
  process.exit(1);
});
