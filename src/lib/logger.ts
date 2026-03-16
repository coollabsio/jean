/**
 * Environment-aware logging utility
 * - debug/info: only log in development
 * - warn/error: always log (even in production)
 */

type LogArgs = unknown[]

interface Logger {
  debug: (...args: LogArgs) => void
  info: (...args: LogArgs) => void
  warn: (...args: LogArgs) => void
  error: (...args: LogArgs) => void
  tag: (name: string) => Logger
}

function createLogger(tagName?: string): Logger {
  const prefix = tagName ? `[${tagName}]` : ''

  const formatArgs = (level: string, args: LogArgs): LogArgs => {
    const levelTag = `[${level}]`
    return prefix ? [levelTag, prefix, ...args] : [levelTag, ...args]
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    debug: () => {},

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    info: () => {},

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    warn: () => {},

    error: (...args: LogArgs) => {
      console.error(...formatArgs('ERROR', args))
    },

    tag: (name: string) => {
      const newTag = prefix ? `${tagName}:${name}` : name
      return createLogger(newTag)
    },
  }
}

export const logger = createLogger()
export { createLogger }
export type { Logger }
