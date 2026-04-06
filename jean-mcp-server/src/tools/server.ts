import { z } from 'zod';

import type { JeanToolDefinition } from './types.js';

export const serverTools: JeanToolDefinition[] = [
  {
    name: 'jean_get_http_server_status',
    description: 'Get Jean HTTP server status payload.',
    command: 'get_http_server_status',
    inputSchema: z.object({}),
  },
  {
    name: 'jean_regenerate_http_token',
    description: 'Regenerate Jean HTTP token. Existing external clients will need to reconnect.',
    command: 'regenerate_http_token',
    inputSchema: z.object({}),
  },
];
