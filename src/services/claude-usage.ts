/**
 * Claude usage service
 *
 * This module provides hooks to fetch Claude Code usage information:
 * - Usage limits (5-hour and 7-day windows) from Anthropic API
 * - Session usage (tokens, cost, context percentage) from local data
 */

import { invoke } from '@tauri-apps/api/core'
import { useQuery } from '@tanstack/react-query'

// ============================================================================
// Types
// ============================================================================

export interface UsageLimit {
  utilization: number
  resetsAt: string | null
}

export interface UsageLimits {
  fiveHour: UsageLimit | null
  sevenDay: UsageLimit | null
}

export interface SessionUsage {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  contextPercentage: number
  estimatedCostUsd: number
}

/**
 * Context data from Jean's Claude Code hook
 * Provides accurate context window tracking
 */
export interface HookContextData {
  sessionId: string
  costUsd: number
  durationMs: number
  contextTokens: number
  contextMaxTokens: number
  contextPercentage: number
  timestamp: string
}

// ============================================================================
// Query Keys
// ============================================================================

export const claudeUsageQueryKeys = {
  all: ['claude-usage'] as const,
  limits: () => [...claudeUsageQueryKeys.all, 'limits'] as const,
  credentials: () => [...claudeUsageQueryKeys.all, 'credentials'] as const,
  session: (sessionId: string) =>
    [...claudeUsageQueryKeys.all, 'session', sessionId] as const,
  hookContext: (sessionId: string) =>
    [...claudeUsageQueryKeys.all, 'hook-context', sessionId] as const,
  hookInstalled: () => [...claudeUsageQueryKeys.all, 'hook-installed'] as const,
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch Claude usage limits from Anthropic API
 * Uses 60-second cache on the backend
 */
export async function getClaudeUsageLimits(): Promise<UsageLimits> {
  return invoke<UsageLimits>('get_claude_usage_limits')
}

/**
 * Fetch session usage (tokens, cost, context %)
 */
export async function getSessionUsage(
  worktreeId: string,
  worktreePath: string,
  sessionId: string
): Promise<SessionUsage> {
  return invoke<SessionUsage>('get_session_usage', {
    worktreeId,
    worktreePath,
    sessionId,
  })
}

/**
 * Check if OAuth credentials are available
 */
export async function hasClaudeCredentials(): Promise<boolean> {
  return invoke<boolean>('has_claude_credentials')
}

/**
 * Get context data from Jean's hook (if installed)
 * Returns null if hook is not installed or data not available
 */
export async function getHookContextData(
  sessionId: string
): Promise<HookContextData | null> {
  return invoke<HookContextData | null>('get_hook_context_data', { sessionId })
}

/**
 * Check if the context tracking hook is installed
 */
export async function isContextHookInstalled(): Promise<boolean> {
  return invoke<boolean>('is_context_hook_installed')
}

/**
 * Install the context tracking hook in Claude Code settings
 */
export async function installContextHook(): Promise<void> {
  return invoke<void>('install_context_hook')
}

/**
 * Uninstall the context tracking hook from Claude Code settings
 */
export async function uninstallContextHook(): Promise<void> {
  return invoke<void>('uninstall_context_hook')
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to get Claude usage limits (5-hour and 7-day windows)
 *
 * Polls every 60 seconds. Returns null limits if no OAuth credentials.
 */
export function useClaudeUsageLimits() {
  return useQuery({
    queryKey: claudeUsageQueryKeys.limits(),
    queryFn: getClaudeUsageLimits,
    staleTime: 60_000, // 60 seconds
    refetchInterval: 60_000, // Poll every 60 seconds
    retry: false, // Don't retry on error (e.g., no credentials)
  })
}

/**
 * Hook to check if OAuth credentials are available
 */
export function useHasClaudeCredentials() {
  return useQuery({
    queryKey: claudeUsageQueryKeys.credentials(),
    queryFn: hasClaudeCredentials,
    staleTime: 5 * 60_000, // 5 minutes
    retry: false,
  })
}

/**
 * Hook to get session usage (tokens, cost, context percentage)
 *
 * Refetches when session changes or after sending messages.
 */
export function useSessionUsage(
  worktreeId: string | null,
  worktreePath: string | null,
  sessionId: string | null
) {
  return useQuery({
    queryKey: sessionId
      ? claudeUsageQueryKeys.session(sessionId)
      : ['session-usage', 'none'],
    queryFn: () => {
      if (!worktreeId || !worktreePath || !sessionId) {
        return null
      }
      return getSessionUsage(worktreeId, worktreePath, sessionId)
    },
    enabled: !!worktreeId && !!worktreePath && !!sessionId,
    staleTime: 10_000, // 10 seconds
    refetchInterval: 30_000, // Poll every 30 seconds
  })
}

/**
 * Hook to get context data from Jean's Claude Code hook
 *
 * This provides accurate context percentage when the hook is installed.
 * Returns null if hook is not set up or no data available.
 */
export function useHookContextData(sessionId: string | null) {
  return useQuery({
    queryKey: sessionId
      ? claudeUsageQueryKeys.hookContext(sessionId)
      : ['hook-context', 'none'],
    queryFn: () => {
      if (!sessionId) {
        return null
      }
      return getHookContextData(sessionId)
    },
    enabled: !!sessionId,
    staleTime: 5_000, // 5 seconds - hook data updates after each response
    refetchInterval: 10_000, // Poll every 10 seconds
  })
}

/**
 * Hook to check if the context tracking hook is installed
 */
export function useIsContextHookInstalled() {
  return useQuery({
    queryKey: claudeUsageQueryKeys.hookInstalled(),
    queryFn: isContextHookInstalled,
    staleTime: 60_000, // 1 minute
  })
}

// ============================================================================
// Formatters
// ============================================================================

/**
 * Format cost in USD (e.g., "$0.42", "$1.23")
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) {
    return '$0.00'
  }
  return `$${costUsd.toFixed(2)}`
}

/**
 * Format reset time (e.g., "4h58m", "45m")
 */
export function formatResetTime(resetsAt: string): string {
  const resetDate = new Date(resetsAt)
  const now = new Date()
  const diffMs = resetDate.getTime() - now.getTime()

  if (diffMs <= 0) {
    return '0m'
  }

  const hours = Math.floor(diffMs / 3600000)
  const minutes = Math.floor((diffMs % 3600000) / 60000)

  if (hours > 0) {
    return `${hours}h${minutes}m`
  }
  return `${minutes}m`
}

/**
 * Calculate and format pacing delta for weekly usage
 * Positive = ahead of expected pace, negative = behind
 */
export function formatPacingDelta(
  utilization: number,
  resetsAt: string | null
): string {
  if (!resetsAt) return ''

  const WEEKLY_HOURS = 168 // 7 days * 24 hours

  const resetDate = new Date(resetsAt)
  const now = new Date()
  const diffMs = resetDate.getTime() - now.getTime()
  const hoursRemaining = Math.max(0, diffMs / 3600000)

  // Calculate expected utilization based on time elapsed
  const timeElapsedPercent =
    ((WEEKLY_HOURS - hoursRemaining) / WEEKLY_HOURS) * 100
  const delta = utilization - timeElapsedPercent

  const sign = delta >= 0 ? '+' : ''
  return `${sign}${delta.toFixed(1)}%`
}

/**
 * Get color class for pacing delta
 */
export function getPacingDeltaColor(delta: number): string {
  if (delta > 5) return 'text-green-500'
  if (delta > 0) return 'text-muted-foreground'
  if (delta > -10) return 'text-yellow-500'
  return 'text-red-500'
}

/**
 * Format tokens with K/M suffix (e.g., "32K", "1.2M")
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`
  }
  return tokens.toString()
}
