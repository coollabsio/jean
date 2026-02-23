import { z } from 'zod';

import type { JeanToolDefinition } from './types.js';

export const skillTools: JeanToolDefinition[] = [
  {
    name: 'jean_list_claude_skills',
    description: 'List Claude skill definitions discoverable by Jean.',
    command: 'list_claude_skills',
    inputSchema: z.object({}),
  },
  {
    name: 'jean_list_claude_commands',
    description: 'List Claude slash-style command definitions discoverable by Jean.',
    command: 'list_claude_commands',
    inputSchema: z.object({}),
  },
];
