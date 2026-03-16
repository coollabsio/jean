import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type { ClaudeSkill, ClaudeCommand } from '@/types/chat'
import { isTauri } from '@/services/projects'

// Query keys for Claude CLI skills and commands
export const skillQueryKeys = {
  all: ['claude-cli'] as const,
  skills: (worktreePath?: string | null) =>
    [...skillQueryKeys.all, 'skills', worktreePath ?? 'global'] as const,
  commands: (worktreePath?: string | null) =>
    [...skillQueryKeys.all, 'commands', worktreePath ?? 'global'] as const,
}

/**
 * Hook to get Claude CLI skills from ~/.claude/skills/ and <project>/.claude/skills/
 * Skills can be attached anywhere in a prompt as context
 * Results are cached for 5 minutes (skills rarely change)
 */
export function useClaudeSkills(worktreePath?: string | null) {
  return useQuery({
    queryKey: skillQueryKeys.skills(worktreePath),
    queryFn: async (): Promise<ClaudeSkill[]> => {
      if (!isTauri()) {
        return []
      }

      try {
        logger.debug('Loading Claude CLI skills')
        const skills = await invoke<ClaudeSkill[]>('list_claude_skills', {
          worktreePath: worktreePath ?? undefined,
        })
        logger.info('Claude CLI skills loaded', { count: skills.length })
        return skills
      } catch (error) {
        logger.error('Failed to load Claude CLI skills', { error })
        return []
      }
    },
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
    gcTime: 1000 * 60 * 10, // Keep in memory for 10 minutes
  })
}

/**
 * Hook to get Claude CLI custom commands from ~/.claude/commands/ and <project>/.claude/commands/
 * Commands can only be executed at the start of an empty prompt
 * Results are cached for 5 minutes (commands rarely change)
 */
export function useClaudeCommands(worktreePath?: string | null) {
  return useQuery({
    queryKey: skillQueryKeys.commands(worktreePath),
    queryFn: async (): Promise<ClaudeCommand[]> => {
      if (!isTauri()) {
        return []
      }

      try {
        logger.debug('Loading Claude CLI custom commands')
        const commands = await invoke<ClaudeCommand[]>('list_claude_commands', {
          worktreePath: worktreePath ?? undefined,
        })
        logger.info('Claude CLI custom commands loaded', {
          count: commands.length,
        })
        return commands
      } catch (error) {
        logger.error('Failed to load Claude CLI custom commands', { error })
        return []
      }
    },
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
    gcTime: 1000 * 60 * 10, // Keep in memory for 10 minutes
  })
}
