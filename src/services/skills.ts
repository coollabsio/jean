import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type { ClaudeSkill, ClaudeCommand, PluginSkillGroup } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import { isTauri } from '@/services/projects'

export const skillQueryKeys = {
  all: ['cli-skills'] as const,
  claudeSkills: (worktreePath?: string | null) =>
    [
      ...skillQueryKeys.all,
      'claude',
      'skills',
      worktreePath ?? 'global',
    ] as const,
  claudeCommands: (worktreePath?: string | null) =>
    [
      ...skillQueryKeys.all,
      'claude',
      'commands',
      worktreePath ?? 'global',
    ] as const,
  codexSkills: (worktreePath?: string | null) =>
    [
      ...skillQueryKeys.all,
      'codex',
      'skills',
      worktreePath ?? 'global',
    ] as const,
  opencodeSkills: () => [...skillQueryKeys.all, 'opencode', 'skills'] as const,
  cursorSkills: () => [...skillQueryKeys.all, 'cursor', 'skills'] as const,
  piSkills: () => [...skillQueryKeys.all, 'pi', 'skills'] as const,
  commandcodeSkills: () =>
    [...skillQueryKeys.all, 'commandcode', 'skills'] as const,
  grokSkills: () => [...skillQueryKeys.all, 'grok', 'skills'] as const,
  pluginSkills: () => [...skillQueryKeys.all, 'plugin', 'skills'] as const,
}

export function useClaudeSkills(worktreePath?: string | null) {
  return useQuery({
    queryKey: skillQueryKeys.claudeSkills(worktreePath),
    queryFn: async (): Promise<ClaudeSkill[]> => {
      if (!isTauri()) return []

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
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useClaudeCommands(worktreePath?: string | null) {
  return useQuery({
    queryKey: skillQueryKeys.claudeCommands(worktreePath),
    queryFn: async (): Promise<ClaudeCommand[]> => {
      if (!isTauri()) return []

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
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

function useBackendSkills(
  backend: Exclude<CliBackend, 'claude'>,
  command:
    | 'list_codex_skills'
    | 'list_opencode_skills'
    | 'list_cursor_skills'
    | 'list_pi_skills'
    | 'list_commandcode_skills'
    | 'list_grok_skills',
  queryKey: readonly unknown[],
  label: string,
  args: Record<string, unknown> = {}
) {
  return useQuery({
    queryKey,
    queryFn: async (): Promise<ClaudeSkill[]> => {
      if (!isTauri()) return []

      try {
        logger.debug(`Loading ${label} skills`)
        const skills = await invoke<ClaudeSkill[]>(command, args)
        logger.info(`${label} skills loaded`, { count: skills.length })
        return skills
      } catch (error) {
        logger.error(`Failed to load ${label} skills`, { error, backend })
        return []
      }
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useCodexSkills(worktreePath?: string | null) {
  return useBackendSkills(
    'codex',
    'list_codex_skills',
    skillQueryKeys.codexSkills(worktreePath),
    'Codex CLI',
    { worktreePath: worktreePath ?? undefined }
  )
}

export function useOpenCodeSkills() {
  return useBackendSkills(
    'opencode',
    'list_opencode_skills',
    skillQueryKeys.opencodeSkills(),
    'OpenCode'
  )
}

export function useCursorSkills() {
  return useBackendSkills(
    'cursor',
    'list_cursor_skills',
    skillQueryKeys.cursorSkills(),
    'Cursor'
  )
}

export function usePiSkills() {
  return useBackendSkills(
    'pi',
    'list_pi_skills',
    skillQueryKeys.piSkills(),
    'Pi'
  )
}

export function useCommandCodeSkills() {
  return useBackendSkills(
    'commandcode',
    'list_commandcode_skills',
    skillQueryKeys.commandcodeSkills(),
    'Command Code'
  )
}

export function useGrokSkills() {
  return useBackendSkills(
    'grok',
    'list_grok_skills',
    skillQueryKeys.grokSkills(),
    'Grok'
  )
}

export interface BackendSkillsGroup {
  backend: CliBackend
  label: string
  skills: ClaudeSkill[]
  commands: ClaudeCommand[]
  /** Optional plugin name for plugin-sourced groups */
  pluginName?: string
}

export function usePluginSkills() {
  return useQuery({
    queryKey: skillQueryKeys.pluginSkills(),
    queryFn: async (): Promise<PluginSkillGroup[]> => {
      if (!isTauri()) return []

      try {
        logger.debug('Loading plugin skills')
        const groups = await invoke<PluginSkillGroup[]>(
          'list_plugin_skills',
          {}
        )
        logger.info('Plugin skills loaded', { groupCount: groups.length })
        return groups
      } catch (error) {
        logger.error('Failed to load plugin skills', { error })
        return []
      }
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAllBackendSkills(
  worktreePath?: string | null,
  installedBackends?: CliBackend[]
): BackendSkillsGroup[] {
  const claudeSkills = useClaudeSkills(worktreePath)
  const claudeCommands = useClaudeCommands(worktreePath)
  const codexSkills = useCodexSkills(worktreePath)
  const opencodeSkills = useOpenCodeSkills()
  const cursorSkills = useCursorSkills()
  const piSkills = usePiSkills()
  const commandcodeSkills = useCommandCodeSkills()
  const grokSkills = useGrokSkills()
  const pluginSkillGroups = usePluginSkills()

  return useMemo(() => {
    const groups: BackendSkillsGroup[] = []
    const installed = new Set(installedBackends ?? [])

    if (installed.has('claude')) {
      const skills = claudeSkills.data ?? []
      const commands = claudeCommands.data ?? []
      if (skills.length > 0 || commands.length > 0) {
        groups.push({ backend: 'claude', label: 'Claude', skills, commands })
      }

      // Add plugin skill groups (only when claude backend is available)
      for (const group of pluginSkillGroups.data ?? []) {
        if (group.skills.length > 0) {
          groups.push({
            backend: 'claude',
            label: group.pluginName,
            skills: group.skills,
            commands: [],
            pluginName: group.pluginName,
          })
        }
      }
    }

    if (installed.has('codex')) {
      const skills = codexSkills.data ?? []
      if (skills.length > 0) {
        groups.push({ backend: 'codex', label: 'Codex', skills, commands: [] })
      }
    }

    if (installed.has('opencode')) {
      const skills = opencodeSkills.data ?? []
      if (skills.length > 0) {
        groups.push({
          backend: 'opencode',
          label: 'OpenCode',
          skills,
          commands: [],
        })
      }
    }

    if (installed.has('cursor')) {
      const skills = cursorSkills.data ?? []
      if (skills.length > 0) {
        groups.push({
          backend: 'cursor',
          label: 'Cursor',
          skills,
          commands: [],
        })
      }
    }

    if (installed.has('pi')) {
      const skills = piSkills.data ?? []
      if (skills.length > 0) {
        groups.push({ backend: 'pi', label: 'Pi', skills, commands: [] })
      }
    }

    if (installed.has('commandcode')) {
      const skills = commandcodeSkills.data ?? []
      if (skills.length > 0) {
        groups.push({
          backend: 'commandcode',
          label: 'Command Code',
          skills,
          commands: [],
        })
      }
    }

    if (installed.has('grok')) {
      const skills = grokSkills.data ?? []
      if (skills.length > 0) {
        groups.push({ backend: 'grok', label: 'Grok', skills, commands: [] })
      }
    }

    return groups
  }, [
    claudeSkills.data,
    claudeCommands.data,
    codexSkills.data,
    opencodeSkills.data,
    cursorSkills.data,
    piSkills.data,
    commandcodeSkills.data,
    grokSkills.data,
    pluginSkillGroups.data,
    installedBackends,
  ])
}
