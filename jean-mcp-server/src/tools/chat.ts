import { z } from 'zod';

import { omitUndefined, pickDefined, requireAny } from './arg-utils.js';
import type { JeanToolDefinition } from './types.js';

const sendChatSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
    worktree_id: z.string().min(1).optional(),
    worktreePath: z.string().min(1).optional(),
    worktree_path: z.string().min(1).optional(),
    message: z.string().min(1),
    model: z.string().optional(),
    executionMode: z.string().optional(),
    execution_mode: z.string().optional(),
    thinkingLevel: z.string().optional(),
    thinking_level: z.string().optional(),
    parallelExecutionPrompt: z.string().optional(),
    parallel_execution_prompt: z.string().optional(),
    aiLanguage: z.string().optional(),
    ai_language: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    allowed_tools: z.array(z.string()).optional(),
    effortLevel: z.string().optional(),
    effort_level: z.string().optional(),
    mcpConfig: z.string().optional(),
    mcp_config: z.string().optional(),
    chromeEnabled: z.boolean().optional(),
    chrome_enabled: z.boolean().optional(),
    customProfileName: z.string().optional(),
    custom_profile_name: z.string().optional(),
    backend: z.string().optional(),
  })
  .refine(
    value => pickDefined(value.sessionId, value.session_id) !== undefined,
    'sessionId/session_id is required.'
  )
  .refine(
    value => pickDefined(value.worktreeId, value.worktree_id) !== undefined,
    'worktreeId/worktree_id is required.'
  )
  .refine(
    value => pickDefined(value.worktreePath, value.worktree_path) !== undefined,
    'worktreePath/worktree_path is required.'
  );

const cancelChatSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
    worktree_id: z.string().min(1).optional(),
  })
  .refine(
    value => pickDefined(value.sessionId, value.session_id) !== undefined,
    'sessionId/session_id is required.'
  )
  .refine(
    value => pickDefined(value.worktreeId, value.worktree_id) !== undefined,
    'worktreeId/worktree_id is required.'
  );

export const chatTools: JeanToolDefinition[] = [
  {
    name: 'jean_send_chat_message',
    description:
      'Send a chat message to an existing Jean session. Mirrors send_chat_message command.',
    command: 'send_chat_message',
    execution: {
      taskSupport: 'optional',
    },
    inputSchema: sendChatSchema,
    toCommandArgs: args =>
      omitUndefined({
        sessionId: requireAny('sessionId/session_id', args.sessionId, args.session_id),
        worktreeId: requireAny(
          'worktreeId/worktree_id',
          args.worktreeId,
          args.worktree_id
        ),
        worktreePath: requireAny(
          'worktreePath/worktree_path',
          args.worktreePath,
          args.worktree_path
        ),
        message: args.message,
        model: args.model,
        executionMode: pickDefined(args.executionMode, args.execution_mode),
        thinkingLevel: pickDefined(args.thinkingLevel, args.thinking_level),
        parallelExecutionPrompt: pickDefined(
          args.parallelExecutionPrompt,
          args.parallel_execution_prompt
        ),
        aiLanguage: pickDefined(args.aiLanguage, args.ai_language),
        allowedTools: pickDefined(args.allowedTools, args.allowed_tools),
        effortLevel: pickDefined(args.effortLevel, args.effort_level),
        mcpConfig: pickDefined(args.mcpConfig, args.mcp_config),
        chromeEnabled: pickDefined(args.chromeEnabled, args.chrome_enabled),
        customProfileName: pickDefined(
          args.customProfileName,
          args.custom_profile_name
        ),
        backend: args.backend,
      }),
  },
  {
    name: 'jean_cancel_chat_message',
    description:
      'Cancel an active chat message stream. Requires sessionId/session_id and worktreeId/worktree_id.',
    command: 'cancel_chat_message',
    inputSchema: cancelChatSchema,
    toCommandArgs: args =>
      omitUndefined({
        sessionId: requireAny('sessionId/session_id', args.sessionId, args.session_id),
        worktreeId: requireAny(
          'worktreeId/worktree_id',
          args.worktreeId,
          args.worktree_id
        ),
      }),
  },
];
