import { chatTools } from './chat.js';
import { contextTools } from './contexts.js';
import { projectTools } from './projects.js';
import { serverTools } from './server.js';
import { sessionTools } from './sessions.js';
import { skillTools } from './skills.js';

export const allTools = [
  ...serverTools,
  ...projectTools,
  ...sessionTools,
  ...chatTools,
  ...contextTools,
  ...skillTools,
];

export const toolMap = new Map(allTools.map(tool => [tool.name, tool]));
