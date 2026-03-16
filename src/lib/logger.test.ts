import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger } from './logger'

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(vi.fn())
    vi.spyOn(console, 'info').mockImplementation(vi.fn())
    vi.spyOn(console, 'warn').mockImplementation(vi.fn())
    vi.spyOn(console, 'error').mockImplementation(vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('no-op methods (debug, info, warn)', () => {
    it('debug does not call console.debug', () => {
      const logger = createLogger()
      logger.debug('test message', { data: 123 })

      expect(console.debug).not.toHaveBeenCalled()
    })

    it('info does not call console.info', () => {
      const logger = createLogger()
      logger.info('info message')

      expect(console.info).not.toHaveBeenCalled()
    })

    it('warn does not call console.warn', () => {
      const logger = createLogger()
      logger.warn('warning message', 'extra')

      expect(console.warn).not.toHaveBeenCalled()
    })
  })

  describe('error (always logs)', () => {
    it('logs errors with correct format', () => {
      const logger = createLogger()
      logger.error('error message', new Error('test'))

      expect(console.error).toHaveBeenCalledWith(
        '[ERROR]',
        'error message',
        expect.any(Error)
      )
    })
  })

  describe('tagged logger', () => {
    it('creates tagged logger with prefix', () => {
      const logger = createLogger('MyComponent')
      logger.error('tagged message')

      expect(console.error).toHaveBeenCalledWith(
        '[ERROR]',
        '[MyComponent]',
        'tagged message'
      )
    })

    it('creates nested tagged logger', () => {
      const logger = createLogger('Parent')
      const childLogger = logger.tag('Child')
      childLogger.error('nested message')

      expect(console.error).toHaveBeenCalledWith(
        '[ERROR]',
        '[Parent:Child]',
        'nested message'
      )
    })

    it('chains multiple tags', () => {
      const logger = createLogger()
      const tagged = logger.tag('A').tag('B').tag('C')
      tagged.error('deep')

      expect(console.error).toHaveBeenCalledWith('[ERROR]', '[A:B:C]', 'deep')
    })
  })

  describe('multiple arguments', () => {
    it('handles multiple arguments', () => {
      const logger = createLogger()
      logger.error('message', 'arg1', 'arg2', { obj: true })

      expect(console.error).toHaveBeenCalledWith(
        '[ERROR]',
        'message',
        'arg1',
        'arg2',
        { obj: true }
      )
    })

    it('handles no arguments', () => {
      const logger = createLogger()
      logger.error()

      expect(console.error).toHaveBeenCalledWith('[ERROR]')
    })
  })
})
