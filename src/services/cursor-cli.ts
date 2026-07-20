/**
 * Cursor CLI management service.
 */

import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  CursorAuthStatus,
  CursorCliStatus,
  CursorInstallCommand,
  CursorModelInfo,
} from '@/types/cursor-cli'
import { hasBackendTransport } from '@/lib/environment'

const isTauri = hasBackendTransport

export const cursorCliQueryKeys = {
  all: ['cursor-cli'] as const,
  status: () => [...cursorCliQueryKeys.all, 'status'] as const,
  auth: () => [...cursorCliQueryKeys.all, 'auth'] as const,
  models: () => [...cursorCliQueryKeys.all, 'models'] as const,
  installCommand: () => [...cursorCliQueryKeys.all, 'install-command'] as const,
}

export function useCursorPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...cursorCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
      package_manager: string | null
    }> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
      try {
        return await invoke<{
          found: boolean
          path: string | null
          version: string | null
          package_manager: string | null
        }>('detect_cursor_in_path')
      } catch (error) {
        logger.debug('Cursor path detection failed', { error })
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useCursorCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: cursorCliQueryKeys.status(),
    queryFn: async (): Promise<CursorCliStatus> => {
      if (!isTauri()) {
        return { installed: false, version: null, path: null }
      }

      try {
        return await invoke<CursorCliStatus>('check_cursor_cli_installed')
      } catch (error) {
        logger.error('Failed to check Cursor CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useCursorCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: cursorCliQueryKeys.auth(),
    queryFn: async (): Promise<CursorAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timed_out: false,
        }
      }

      try {
        return await invoke<CursorAuthStatus>('check_cursor_cli_auth')
      } catch (error) {
        logger.error('Failed to check Cursor CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
          timed_out: false,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAvailableCursorModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: cursorCliQueryKeys.models(),
    queryFn: async (): Promise<CursorModelInfo[]> => {
      if (!isTauri()) return []

      try {
        return await invoke<CursorModelInfo[]>('list_cursor_models')
      } catch (error) {
        logger.error('Failed to list Cursor models', { error })
        return []
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export async function getCursorInstallCommand(): Promise<CursorInstallCommand> {
  return invoke<CursorInstallCommand>('get_cursor_install_command')
}
