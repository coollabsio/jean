/**
 * Shared CLI update action resolution.
 *
 * Single source of truth for "how do we update a PATH-installed CLI?".
 * Used by both the preferences page (manual Update button) and the startup
 * update toast notification so the two paths don't drift.
 */

export type CliType =
  | 'claude'
  | 'gh'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'coderabbit'
  | 'commandcode'

/** Binary name used by the package manager (e.g. `brew upgrade <name>`). */
export const CLI_BINARY_NAMES: Record<CliType, string> = {
  claude: 'claude-code',
  gh: 'gh',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  coderabbit: 'coderabbit',
  commandcode: 'command-code',
}

/** npm package name for CLIs that ship as npm/bun globals. */
export const NPM_PACKAGE_NAMES: Partial<Record<CliType, string>> = {
  codex: '@openai/codex',
  pi: '@earendil-works/pi-coding-agent',
}

/** Built-in self-update subcommand args, or null if the CLI has none. */
export const CLI_SELF_UPDATE_ARGS: Record<CliType, string[] | null> = {
  claude: ['update'],
  opencode: ['upgrade'],
  coderabbit: ['update'],
  pi: ['update', '--self'],
  commandcode: ['update'],
  gh: null,
  codex: null,
}

export const CLI_DISPLAY_NAMES: Record<CliType, string> = {
  claude: 'Claude CLI',
  gh: 'GitHub CLI',
  codex: 'Codex CLI',
  opencode: 'OpenCode CLI',
  pi: 'PI CLI',
  coderabbit: 'CodeRabbit CLI',
  commandcode: 'Command Code CLI',
}

/** Get [command, args] for updating a PATH-mode CLI, respecting package manager.
 *  Returns null when the CLI has no self-update command and no known package manager. */
export function getPathUpdateAction(
  cliPath: string | null | undefined,
  packageManager: string | null | undefined,
  brewPkg: string,
  selfUpdateArgs: string[] | null,
  npmPkg?: string,
  targetVersion?: string
): [string, string[]] | null {
  if (packageManager === 'homebrew') {
    return ['brew', ['upgrade', brewPkg]]
  }
  if (selfUpdateArgs) {
    return [cliPath ?? brewPkg, selfUpdateArgs]
  }
  if (packageManager === 'bun' && npmPkg && targetVersion) {
    return ['bun', ['install', '-g', `${npmPkg}@${targetVersion}`]]
  }
  if (packageManager === 'npm' && npmPkg && targetVersion) {
    return ['npm', ['install', '-g', `${npmPkg}@${targetVersion}`]]
  }
  return null
}

/** Convenience wrapper: resolve the update action for a given CLI type using
 *  the per-CLI constants above. */
export function resolveCliPathUpdateAction(
  type: CliType,
  cliPath: string | null | undefined,
  packageManager: string | null | undefined,
  targetVersion: string | null | undefined
): [string, string[]] | null {
  const selfUpdateArgs = CLI_SELF_UPDATE_ARGS[type]
  if (type === 'pi' && selfUpdateArgs) {
    return [cliPath ?? CLI_BINARY_NAMES[type], selfUpdateArgs]
  }

  return getPathUpdateAction(
    cliPath,
    packageManager,
    CLI_BINARY_NAMES[type],
    selfUpdateArgs,
    NPM_PACKAGE_NAMES[type],
    targetVersion ?? undefined
  )
}
