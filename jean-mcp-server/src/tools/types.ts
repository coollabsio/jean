import { z } from 'zod';

export interface JeanToolDefinition<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  command: string;
  execution?: {
    taskSupport: 'optional' | 'required' | 'forbidden';
  };
  inputSchema: TSchema;
  toCommandArgs?: (args: z.infer<TSchema>) => Record<string, unknown>;
}
