/**
 * Antigravity CLI (`agy`) management service.
 *
 * Antigravity is a standalone Go binary resolved from PATH (no Jean-managed
 * install) and authenticates via a Google account.
 */

import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { hasBackendTransport } from '@/lib/environment'
import type {
  AntigravityAuthStatus,
  AntigravityCliStatus,
  AntigravityModelInfo,
} from '@/types/antigravity-cli'

const isTauri = hasBackendTransport

export const antigravityCliQueryKeys = {
  all: ['antigravity-cli'] as const,
  status: () => [...antigravityCliQueryKeys.all, 'status'] as const,
  auth: () => [...antigravityCliQueryKeys.all, 'auth'] as const,
  models: () => [...antigravityCliQueryKeys.all, 'models'] as const,
  pathDetection: () => [...antigravityCliQueryKeys.all, 'path-detection'] as const,
}

export function useAntigravityPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.pathDetection(),
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
      packageManager: string | null
    }> => {
      if (!isTauri()) {
        return { found: false, path: null, version: null, packageManager: null }
      }
      try {
        return await invoke('detect_antigravity_in_path')
      } catch (error) {
        logger.debug('Antigravity path detection failed', { error })
        return { found: false, path: null, version: null, packageManager: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useAntigravityCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.status(),
    queryFn: async (): Promise<AntigravityCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<AntigravityCliStatus>(
          'check_antigravity_cli_installed'
        )
      } catch (error) {
        logger.error('Failed to check Antigravity CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useAntigravityCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.auth(),
    queryFn: async (): Promise<AntigravityAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invoke<AntigravityAuthStatus>('check_antigravity_cli_auth')
      } catch (error) {
        logger.error('Failed to check Antigravity CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
          timedOut: false,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAntigravityModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.models(),
    queryFn: async (): Promise<AntigravityModelInfo[]> => {
      if (!isTauri()) return []
      try {
        return await invoke<AntigravityModelInfo[]>('list_antigravity_models')
      } catch (error) {
        logger.error('Failed to list Antigravity models', { error })
        return []
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}
