/**
 * AI CLI services
 *
 * React Query hooks for interacting with AI CLI providers (Gemini, Codex).
 * Claude CLI is handled separately in claude-cli.ts.
 */

import { invoke } from '@tauri-apps/api/core'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AiCliStatus, AiCliAuthStatus } from '@/types/ai-cli'

// =============================================================================
// Query Keys
// =============================================================================

export const aiCliQueryKeys = {
  all: ['ai-cli'] as const,
  gemini: {
    status: ['ai-cli', 'gemini', 'status'] as const,
    auth: ['ai-cli', 'gemini', 'auth'] as const,
  },
  codex: {
    status: ['ai-cli', 'codex', 'status'] as const,
    auth: ['ai-cli', 'codex', 'auth'] as const,
  },
}

// =============================================================================
// Gemini CLI Hooks
// =============================================================================

/** Check if Gemini CLI is installed */
export function useGeminiCliStatus() {
  return useQuery({
    queryKey: aiCliQueryKeys.gemini.status,
    queryFn: async (): Promise<AiCliStatus> => {
      return await invoke<AiCliStatus>('check_gemini_cli_installed')
    },
    staleTime: 60 * 1000, // 1 minute
  })
}

/** Check if Gemini CLI is authenticated */
export function useGeminiCliAuth(enabled = true) {
  return useQuery({
    queryKey: aiCliQueryKeys.gemini.auth,
    queryFn: async (): Promise<AiCliAuthStatus> => {
      return await invoke<AiCliAuthStatus>('check_gemini_cli_auth')
    },
    enabled,
    staleTime: 60 * 1000, // 1 minute
  })
}

/** Install Gemini CLI */
export function useInstallGeminiCli() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<string> => {
      return await invoke<string>('install_gemini_cli')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: aiCliQueryKeys.gemini.status })
      queryClient.invalidateQueries({ queryKey: aiCliQueryKeys.gemini.auth })
    },
  })
}

// =============================================================================
// Codex CLI Hooks
// =============================================================================

/** Check if Codex CLI is installed */
export function useCodexCliStatus() {
  return useQuery({
    queryKey: aiCliQueryKeys.codex.status,
    queryFn: async (): Promise<AiCliStatus> => {
      return await invoke<AiCliStatus>('check_codex_cli_installed')
    },
    staleTime: 60 * 1000, // 1 minute
  })
}

/** Check if Codex CLI is authenticated */
export function useCodexCliAuth(enabled = true) {
  return useQuery({
    queryKey: aiCliQueryKeys.codex.auth,
    queryFn: async (): Promise<AiCliAuthStatus> => {
      return await invoke<AiCliAuthStatus>('check_codex_cli_auth')
    },
    enabled,
    staleTime: 60 * 1000, // 1 minute
  })
}

/** Install Codex CLI */
export function useInstallCodexCli() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (): Promise<string> => {
      return await invoke<string>('install_codex_cli')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: aiCliQueryKeys.codex.status })
      queryClient.invalidateQueries({ queryKey: aiCliQueryKeys.codex.auth })
    },
  })
}
