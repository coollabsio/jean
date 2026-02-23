import { z } from 'zod';

import type { JeanToolDefinition } from './types.js';

export const contextTools: JeanToolDefinition[] = [
  {
    name: 'jean_list_saved_contexts',
    description: 'List saved context files available in Jean.',
    command: 'list_saved_contexts',
    inputSchema: z.object({}),
  },
  {
    name: 'jean_read_context_file',
    description: 'Read one saved context file by path.',
    command: 'read_context_file',
    inputSchema: z.object({
      path: z.string().min(1),
    }),
  },
];
