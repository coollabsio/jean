import { useMemo } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type { ClaudeSkill, ClaudeCommand, PluginSkillGroup } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import { isTauri } from '@/services/projects'

export const skillQueryKeys = {
  all: ['cli-skills'] as const,
  claudeSkills: (worktreeId?: string | null, worktreePath?: string | null) =>
    [
      ...skillQueryKeys.all,
      'claude',
      'skills',
      worktreePath ?? 'global',
      worktreeId ?? '',
    ] as const,
  claudeCommands: (worktreeId?: string | null, worktreePath?: string | null) =>
    [
      ...skillQueryKeys.all,
      'claude',
      'commands',
      worktreePath ?? 'global',
      worktreeId ?? '',
    ] as const,
  codexSkills: (worktreeId?: string | null, worktreePath?: string | null) =>
    [
      ...skillQueryKeys.all,
      'codex',
      'skills',
      worktreePath ?? 'global',
      worktreeId ?? '',
    ] as const,
  opencodeSkills: () => [...skillQueryKeys.all, 'opencode', 'skills'] as const,
  cursorSkills: () => [...skillQueryKeys.all, 'cursor', 'skills'] as const,
  piSkills: () => [...skillQueryKeys.all, 'pi', 'skills'] as const,
  commandcodeSkills: () =>
    [...skillQueryKeys.all, 'commandcode', 'skills'] as const,
  grokSkills: () => [...skillQueryKeys.all, 'grok', 'skills'] as const,
  pluginSkills: () => [...skillQueryKeys.all, 'plugin', 'skills'] as const,
}

type SkillsCommand =
  | 'list_claude_skills'
  | 'list_codex_skills'
  | 'list_opencode_skills'
  | 'list_cursor_skills'
  | 'list_pi_skills'
  | 'list_commandcode_skills'
  | 'list_grok_skills'
  | 'list_plugin_skills'

function skillListQuery<T>(
  queryKey: readonly unknown[],
  command: SkillsCommand | 'list_claude_commands',
  label: string,
  args: Record<string, unknown> = {}
) {
  return queryOptions({
    queryKey,
    queryFn: async (): Promise<T[]> => {
      if (!isTauri()) return []

      try {
        logger.debug(`Loading ${label}`)
        const items = await invoke<T[]>(command, args)
        logger.info(`${label} loaded`, { count: items.length })
        return items
      } catch (error) {
        logger.error(`Failed to load ${label}`, { error })
        return []
      }
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

const worktreeArgs = (
  worktreeId: string | null | undefined,
  worktreePath: string | null | undefined
) => ({
  worktreeId: worktreeId ?? undefined,
  worktreePath: worktreePath ?? undefined,
})

/** Query options for every skill and command list, shared by the slash
 *  popover and the send path. */
export const skillQueries = {
  claudeSkills: (
    worktreeId: string | null | undefined,
    worktreePath: string | null | undefined
  ) =>
    skillListQuery<ClaudeSkill>(
      skillQueryKeys.claudeSkills(worktreeId, worktreePath),
      'list_claude_skills',
      'Claude CLI skills',
      worktreeArgs(worktreeId, worktreePath)
    ),
  claudeCommands: (
    worktreeId: string | null | undefined,
    worktreePath: string | null | undefined
  ) =>
    skillListQuery<ClaudeCommand>(
      skillQueryKeys.claudeCommands(worktreeId, worktreePath),
      'list_claude_commands',
      'Claude CLI custom commands',
      worktreeArgs(worktreeId, worktreePath)
    ),
  codexSkills: (
    worktreeId: string | null | undefined,
    worktreePath: string | null | undefined
  ) =>
    skillListQuery<ClaudeSkill>(
      skillQueryKeys.codexSkills(worktreeId, worktreePath),
      'list_codex_skills',
      'Codex CLI skills',
      worktreeArgs(worktreeId, worktreePath)
    ),
  opencodeSkills: () =>
    skillListQuery<ClaudeSkill>(
      skillQueryKeys.opencodeSkills(),
      'list_opencode_skills',
      'OpenCode skills'
    ),
  cursorSkills: () =>
    skillListQuery<ClaudeSkill>(
      skillQueryKeys.cursorSkills(),
      'list_cursor_skills',
      'Cursor skills'
    ),
  piSkills: () =>
    skillListQuery<ClaudeSkill>(
      skillQueryKeys.piSkills(),
      'list_pi_skills',
      'Pi skills'
    ),
  commandcodeSkills: () =>
    skillListQuery<ClaudeSkill>(
      skillQueryKeys.commandcodeSkills(),
      'list_commandcode_skills',
      'Command Code skills'
    ),
  grokSkills: () =>
    skillListQuery<ClaudeSkill>(
      skillQueryKeys.grokSkills(),
      'list_grok_skills',
      'Grok skills'
    ),
  pluginSkills: () =>
    skillListQuery<PluginSkillGroup>(
      skillQueryKeys.pluginSkills(),
      'list_plugin_skills',
      'Plugin skills'
    ),
}

export interface BackendSkillsGroup {
  backend: CliBackend
  label: string
  skills: ClaudeSkill[]
  commands: ClaudeCommand[]
  /** Optional plugin name for plugin-sourced groups */
  pluginName?: string
}

/** Skill and command lists load only while `enabled` (the popover is open).
 *  `prefetchInputLists` loads them earlier in idle time. */
export function useAllBackendSkills(
  worktreeId: string | null | undefined,
  worktreePath: string | null | undefined,
  installedBackends?: CliBackend[],
  enabled = true
): BackendSkillsGroup[] {
  const claudeSkills = useQuery({
    ...skillQueries.claudeSkills(worktreeId, worktreePath),
    enabled,
  })
  const claudeCommands = useQuery({
    ...skillQueries.claudeCommands(worktreeId, worktreePath),
    enabled,
  })
  const codexSkills = useQuery({
    ...skillQueries.codexSkills(worktreeId, worktreePath),
    enabled,
  })
  const opencodeSkills = useQuery({ ...skillQueries.opencodeSkills(), enabled })
  const cursorSkills = useQuery({ ...skillQueries.cursorSkills(), enabled })
  const piSkills = useQuery({ ...skillQueries.piSkills(), enabled })
  const commandcodeSkills = useQuery({
    ...skillQueries.commandcodeSkills(),
    enabled,
  })
  const grokSkills = useQuery({ ...skillQueries.grokSkills(), enabled })
  const pluginSkillGroups = useQuery({
    ...skillQueries.pluginSkills(),
    enabled,
  })

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
