import { z } from 'zod';

import { omitUndefined, pickDefined, requireAny } from './arg-utils.js';
import type { JeanToolDefinition } from './types.js';

const worktreeLocatorBaseSchema = z.object({
  worktreeId: z.string().min(1).optional(),
  worktree_id: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  worktree_path: z.string().min(1).optional(),
});

const sessionLocatorSchema = worktreeLocatorBaseSchema
  .extend({
    sessionId: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
  })
  .refine(
    value => pickDefined(value.worktreeId, value.worktree_id) !== undefined,
    'worktreeId/worktree_id is required.'
  )
  .refine(
    value => pickDefined(value.worktreePath, value.worktree_path) !== undefined,
    'worktreePath/worktree_path is required.'
  )
  .refine(
    value => pickDefined(value.sessionId, value.session_id) !== undefined,
    'sessionId/session_id is required.'
  );

export const sessionTools: JeanToolDefinition[] = [
  {
    name: 'jean_get_sessions',
    description:
      'List sessions for a worktree. Requires both worktreeId/worktree_id and worktreePath/worktree_path.',
    command: 'get_sessions',
    inputSchema: worktreeLocatorBaseSchema
      .extend({
        includeArchived: z.boolean().optional(),
        include_archived: z.boolean().optional(),
        includeMessageCounts: z.boolean().optional(),
        include_message_counts: z.boolean().optional(),
      })
      .refine(
        value => pickDefined(value.worktreeId, value.worktree_id) !== undefined,
        'worktreeId/worktree_id is required.'
      )
      .refine(
        value => pickDefined(value.worktreePath, value.worktree_path) !== undefined,
        'worktreePath/worktree_path is required.'
      ),
    toCommandArgs: args =>
      omitUndefined({
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
        includeArchived: pickDefined(args.includeArchived, args.include_archived),
        includeMessageCounts: pickDefined(
          args.includeMessageCounts,
          args.include_message_counts
        ),
      }),
  },
  {
    name: 'jean_get_session',
    description:
      'Get one session including message history. Requires worktree + session identifiers.',
    command: 'get_session',
    inputSchema: sessionLocatorSchema,
    toCommandArgs: args =>
      omitUndefined({
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
        sessionId: requireAny('sessionId/session_id', args.sessionId, args.session_id),
      }),
  },
  {
    name: 'jean_create_session',
    description:
      'Create a session in a worktree. Requires worktreeId/worktreePath and optional name.',
    command: 'create_session',
    inputSchema: worktreeLocatorBaseSchema
      .extend({
        name: z.string().min(1).optional(),
      })
      .refine(
        value => pickDefined(value.worktreeId, value.worktree_id) !== undefined,
        'worktreeId/worktree_id is required.'
      )
      .refine(
        value => pickDefined(value.worktreePath, value.worktree_path) !== undefined,
        'worktreePath/worktree_path is required.'
      ),
    toCommandArgs: args =>
      omitUndefined({
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
        name: args.name,
      }),
  },
];
