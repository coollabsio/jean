import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_OWNERS,
  PATH_ARGUMENT_KEYS,
  ROUTED_ARGUMENT_KEYS,
} from './server-command-routing'

/**
 * Commands that read an owner-looking key yet belong to the active transport.
 * Each needs a reason: anything else must name its owner in COMMAND_OWNERS.
 */
const ACTIVE_SERVER_COMMANDS: Record<string, string> = {
  load_ui_state: 'clientId names this desktop client, not a server resource',
  save_ui_state: 'clientId names this desktop client, not a server resource',
  init_git_in_folder:
    'GitInitModal runs its whole add-project flow on the active server',
  resolve_claude_command: 'resolves a CLI binary path on the active server',
}

const OWNER_LOOKING_KEY = /(path|Path|_id|Id|Ids|_ids)$/

/** Command name to the argument keys its dispatch arm reads. */
function dispatchCommandKeys(): Map<string, Set<string>> {
  const source = readFileSync(
    `${process.cwd()}/jean-core/src/http_server/dispatch.rs`,
    'utf8'
  )
  const arms = [
    ...source.matchAll(
      /^ {8,12}("[a-z0-9_]+"(?:\s*\|\s*"[a-z0-9_]+")*)\s*=>/gm
    ),
  ]
  const commands = new Map<string, Set<string>>()
  arms.forEach((arm, index) => {
    const body = source.slice(arm.index, arms[index + 1]?.index)
    const keys = new Set<string>()
    for (const read of body.matchAll(
      /\b(?:from_field|field)(?:_opt|_nullable_option)?(?:::<[^>]*>)?\(\s*&?args,\s*"([^"]+)"(?:,\s*"([^"]+)")?/g
    )) {
      if (read[1]) keys.add(read[1])
      if (read[2]) keys.add(read[2])
    }
    for (const read of body.matchAll(/args\.get\("([^"]+)"\)/g)) {
      if (read[1]) keys.add(read[1])
    }
    for (const name of arm[1]?.matchAll(/"([a-z0-9_]+)"/g) ?? []) {
      if (name[1]) commands.set(name[1], keys)
    }
  })
  return commands
}

/**
 * A command is routed when the transport can find its owner: a routed id or
 * registered path in its arguments, or a COMMAND_OWNERS entry. Other owner-
 * looking keys (messageId, rpcId, checkpointId) are then scoped under that
 * routed resource.
 */
function unroutedCommands(commands: Map<string, Set<string>>): string[] {
  return [...commands].flatMap(([command, keys]) => {
    const routedByKey = [...keys].some(
      key => ROUTED_ARGUMENT_KEYS.has(key) || PATH_ARGUMENT_KEYS.has(key)
    )
    const ownerLooking = [...keys].filter(key => OWNER_LOOKING_KEY.test(key))
    if (routedByKey || ownerLooking.length === 0) return []
    if (command in COMMAND_OWNERS || command in ACTIVE_SERVER_COMMANDS) {
      return []
    }
    return [`${command} (reads ${ownerLooking.join(', ')})`]
  })
}

describe('dispatch command ownership', () => {
  const commands = dispatchCommandKeys()

  it('parses the dispatch command arms', () => {
    expect(commands.size).toBeGreaterThan(400)
    expect([...(commands.get('read_pasted_text') ?? [])]).toEqual(['path'])
    expect([...(commands.get('attach_session_reference') ?? [])]).toContain(
      'targetSessionId'
    )
  })

  it('routes every command that addresses a server-owned resource', () => {
    const missing = unroutedCommands(commands)
    expect(
      missing,
      [
        'These dispatch commands read a path or id whose owning Jean server the',
        'transport cannot see, so native multi-server clients send them to the',
        'wrong server. Add each to COMMAND_OWNERS in',
        'src/lib/server-command-routing.ts (owner: the id keys callers must',
        'send, or fanOut: the mixed-server array key). Add it to',
        'ACTIVE_SERVER_COMMANDS in this file only when it has no owner.',
      ].join(' ')
    ).toEqual([])
  })

  it('keeps table entries pointed at real dispatch commands', () => {
    const stale = [
      ...Object.keys(COMMAND_OWNERS),
      ...Object.keys(ACTIVE_SERVER_COMMANDS),
    ].filter(command => !commands.has(command))
    expect(stale).toEqual([])
  })
})
