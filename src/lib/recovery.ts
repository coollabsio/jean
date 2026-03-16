import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'

/**
 * Simple data recovery pattern for saving important data to disk
 *
 * Uses the same approach as preferences - JSON files in the app data directory
 * Files are saved to ~/Library/Application Support/[app]/recovery/
 */

export interface RecoveryOptions {
  /** Suppress error notifications (useful for background saves) */
  silent?: boolean
}

/**
 * Save any JSON-serializable data to a recovery file
 *
 * @param filename Base filename (without extension)
 * @param data Any JSON-serializable data
 * @param options Recovery options
 *
 * @example
 * ```typescript
 * // Save user draft
 * await saveEmergencyData('user-draft', { content: 'Hello world', timestamp: Date.now() })
 *
 * // Save app state before risky operation
 * await saveEmergencyData('app-state', { currentView: 'dashboard', unsavedChanges: true })
 * ```
 */
export async function saveEmergencyData(
  filename: string,
  data: unknown,
  options: RecoveryOptions = {}
): Promise<void> {
  try {
    logger.debug('Saving emergency data', { filename, dataType: typeof data })

    await invoke('save_emergency_data', {
      filename,
      data,
    })

    if (!options.silent) {
      logger.info('Emergency data saved successfully', { filename })
    }
  } catch (error) {
    logger.error('Failed to save emergency data', { filename, error })
    throw error
  }
}

/**
 * Load data from a recovery file
 *
 * @param filename Base filename (without extension)
 * @returns The recovered data or null if file doesn't exist
 *
 * @example
 * ```typescript
 * // Load user draft
 * const draft = await loadEmergencyData('user-draft')
 * if (draft) {
 *   console.log('Found saved draft:', draft.content)
 * }
 * ```
 */
export async function loadEmergencyData<T = unknown>(
  filename: string
): Promise<T | null> {
  try {
    logger.debug('Loading emergency data', { filename })

    const data = await invoke<T>('load_emergency_data', {
      filename,
    })

    logger.info('Emergency data loaded successfully', { filename })
    return data
  } catch (error) {
    if (
      error &&
      typeof error === 'string' &&
      error.includes('File not found')
    ) {
      logger.debug('Recovery file not found', { filename })
      return null
    }

    logger.error('Failed to load emergency data', { filename, error })
    throw error
  }
}

/**
 * Clean up old recovery files (older than 7 days)
 * Called automatically on app startup
 *
 * @returns Number of files removed
 *
 * @example
 * ```typescript
 * const removedCount = await cleanupOldFiles()
 * console.log(`Cleaned up ${removedCount} old recovery files`)
 * ```
 */
export async function cleanupOldFiles(): Promise<number> {
  try {
    logger.debug('Starting recovery file cleanup')

    const removedCount = await invoke<number>('cleanup_old_recovery_files')

    if (removedCount > 0) {
      logger.info('Cleaned up old recovery files', { removedCount })
    } else {
      logger.debug('No old recovery files to clean up')
    }

    return removedCount
  } catch (error) {
    logger.error('Failed to cleanup old recovery files', { error })
    throw error
  }
}

/**
 * Save app state with timestamp for crash recovery
 * This is typically called by the error boundary
 *
 * @param state Current app state to save
 * @param crashInfo Optional crash information
 *
 * @example
 * ```typescript
 * // Save crash state in error boundary
 * await saveCrashState({
 *   currentPage: '/dashboard',
 *   userInput: formData,
 *   sessionId: 'abc123'
 * }, { error: error.message, stack: error.stack })
 * ```
 */
export async function saveCrashState(
  state: unknown,
  crashInfo?: { error?: string; stack?: string; componentStack?: string }
): Promise<void> {
  const timestamp = Date.now()
  const filename = `crash-${timestamp}`

  const crashData = {
    timestamp,
    state,
    crashInfo,
    userAgent: navigator.userAgent,
    url: window.location.href,
  }

  try {
    await saveEmergencyData(filename, crashData, { silent: true })
    logger.info('Crash state saved', { filename, timestamp })
  } catch (error) {
    // Don't throw from crash handler - just log
    logger.error('Failed to save crash state', { error })
  }
}
