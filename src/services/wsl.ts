import { useQuery, type QueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { hasBackend } from '@/lib/environment'
import { claudeCliQueryKeys } from '@/services/claude-cli'
import { codexCliQueryKeys } from '@/services/codex-cli'
import { cursorCliQueryKeys } from '@/services/cursor-cli'
import { ghCliQueryKeys } from '@/services/gh-cli'
import { opencodeCliQueryKeys } from '@/services/opencode-cli'

const isBackendAvailable = hasBackend

export const wslQueryKeys = {
  all: ['wsl'] as const,
  availability: () => [...wslQueryKeys.all, 'availability'] as const,
  distros: () => [...wslQueryKeys.all, 'distros'] as const,
}

export function useWslAvailability(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: wslQueryKeys.availability(),
    queryFn: async (): Promise<boolean> => {
      if (!isBackendAvailable()) {
        logger.debug('Not in backend context, returning WSL unavailable')
        return false
      }

      try {
        const available = await invoke<boolean>('is_wsl_available')
        logger.debug('WSL availability checked', { available })
        return available
      } catch (error) {
        logger.warn('Failed to check WSL availability', { error })
        return false
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
  })
}

export function useWslDistros(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: wslQueryKeys.distros(),
    queryFn: async (): Promise<string[]> => {
      if (!isBackendAvailable()) {
        logger.debug('Not in backend context, returning no WSL distros')
        return []
      }

      try {
        const distros = await invoke<string[]>('list_wsl_distros')
        const normalized = Array.from(
          new Set(distros.map(distro => distro.trim()).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b))
        logger.debug('WSL distros loaded', { distros: normalized })
        return normalized
      } catch (error) {
        logger.warn('Failed to load WSL distros', { error })
        return []
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
  })
}

export async function invalidateWslSensitiveQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: wslQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: cursorCliQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.all }),
  ])
}
