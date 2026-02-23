export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(
    private readonly minLevel: LogLevel,
    private readonly scope = 'jean-mcp-server'
  ) {}

  child(childScope: string): Logger {
    return new Logger(this.minLevel, `${this.scope}:${childScope}`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>
  ): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
    };

    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = value;
      }
    }

    console.error(JSON.stringify(record));
  }
}
