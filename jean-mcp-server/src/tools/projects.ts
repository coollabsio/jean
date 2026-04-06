import { z } from 'zod';

import { omitUndefined, pickDefined, requireAny } from './arg-utils.js';
import type { JeanToolDefinition } from './types.js';

const projectIdBaseSchema = z.object({
  projectId: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
});

const projectIdSchema = projectIdBaseSchema
  .refine(
    value => pickDefined(value.projectId, value.project_id) !== undefined,
    'projectId/project_id is required.'
  );

const worktreeIdBaseSchema = z.object({
  worktreeId: z.string().min(1).optional(),
  worktree_id: z.string().min(1).optional(),
});

const worktreeIdSchema = worktreeIdBaseSchema
  .refine(
    value => pickDefined(value.worktreeId, value.worktree_id) !== undefined,
    'worktreeId/worktree_id is required.'
  );

export const projectTools: JeanToolDefinition[] = [
  {
    name: 'jean_list_projects',
    description: 'List all projects known by Jean.',
    command: 'list_projects',
    inputSchema: z.object({}),
  },
  {
    name: 'jean_list_worktrees',
    description: 'List worktrees for a project.',
    command: 'list_worktrees',
    inputSchema: projectIdSchema,
    toCommandArgs: args => ({
      projectId: requireAny('projectId/project_id', args.projectId, args.project_id),
    }),
  },
  {
    name: 'jean_get_worktree',
    description: 'Get detailed worktree metadata.',
    command: 'get_worktree',
    inputSchema: worktreeIdSchema,
    toCommandArgs: args => ({
      worktreeId: requireAny('worktreeId/worktree_id', args.worktreeId, args.worktree_id),
    }),
  },
  {
    name: 'jean_create_worktree',
    description:
      'Create a new worktree. Supports optional base branch, issue/pr context, and custom name.',
    command: 'create_worktree',
    inputSchema: projectIdBaseSchema
      .extend({
        baseBranch: z.string().optional(),
        base_branch: z.string().optional(),
        issueContext: z.unknown().optional(),
        issue_context: z.unknown().optional(),
        prContext: z.unknown().optional(),
        pr_context: z.unknown().optional(),
        customName: z.string().optional(),
        custom_name: z.string().optional(),
      })
      .refine(
        value => pickDefined(value.projectId, value.project_id) !== undefined,
        'projectId/project_id is required.'
      ),
    toCommandArgs: args =>
      omitUndefined({
        projectId: requireAny(
          'projectId/project_id',
          args.projectId,
          args.project_id
        ),
        baseBranch: pickDefined(args.baseBranch, args.base_branch),
        issueContext: pickDefined(args.issueContext, args.issue_context),
        prContext: pickDefined(args.prContext, args.pr_context),
        customName: pickDefined(args.customName, args.custom_name),
      }),
  },
  {
    name: 'jean_archive_worktree',
    description: 'Archive a worktree by id.',
    command: 'archive_worktree',
    inputSchema: worktreeIdSchema,
    toCommandArgs: args => ({
      worktreeId: requireAny('worktreeId/worktree_id', args.worktreeId, args.worktree_id),
    }),
  },
  {
    name: 'jean_unarchive_worktree',
    description: 'Unarchive a worktree by id.',
    command: 'unarchive_worktree',
    inputSchema: worktreeIdSchema,
    toCommandArgs: args => ({
      worktreeId: requireAny('worktreeId/worktree_id', args.worktreeId, args.worktree_id),
    }),
  },
];
