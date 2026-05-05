import type { AcpAvailableCommand } from '../store/acp-store'

export interface SlashGhost {
  prefix: string
  hint: string
}

export function buildSlashGhost(cmd: AcpAvailableCommand): SlashGhost | null {
  const hint = cmd.input?.hint?.trim()
  if (!hint) return null
  return {
    prefix: `/${cmd.name} `,
    hint,
  }
}

export function shouldKeepSlashGhost(
  value: string,
  ghost: SlashGhost | null
): boolean {
  if (!ghost) return false
  return value.startsWith(ghost.prefix)
}

export function getVisibleSlashGhostHint(
  value: string,
  ghost: SlashGhost | null
): string | null {
  if (!ghost) return null
  return value === ghost.prefix ? ghost.hint : null
}
