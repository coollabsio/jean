// Command system exports
export * from './registry'
export * from '../../hooks/use-command-context'
import { appearanceCommands } from './appearance-commands'
import { notificationCommands } from './notification-commands'
import { projectCommands } from './project-commands'
import { githubCommands } from './github-commands'
import { maintenanceCommands } from './maintenance-commands'
import { nightshiftCommands } from './nightshift-commands'
import { windowCommands } from './window-commands'
import { registerCommands } from './registry'

/**
 * Initialize the command system by registering all commands.
 * This should be called once during app initialization.
 */
export function initializeCommandSystem(): void {
  registerCommands(appearanceCommands)
  registerCommands(notificationCommands)
  registerCommands(projectCommands)
  registerCommands(githubCommands)
  registerCommands(maintenanceCommands)
  registerCommands(nightshiftCommands)
  registerCommands(windowCommands)
}

export {
  appearanceCommands,
  notificationCommands,
  projectCommands,
  githubCommands,
  maintenanceCommands,
  nightshiftCommands,
  windowCommands,
}
