import { invokeForOptionalServer } from '@/lib/transport'

export interface SystemPrerequisites {
  gitInstalled: boolean
  gitVersion: string | null
  nodeInstalled: boolean
  nodeVersion: string | null
  npmInstalled: boolean
  npmVersion: string | null
  platform: string
  automaticInstallSupported: boolean
  automaticInstallCommand: string | null
  manualInstallUrl: string
}

/** Checks the local core, or the given Jean server when `serverId` is set. */
export function checkSystemPrerequisites(serverId?: string) {
  return invokeForOptionalServer<SystemPrerequisites>(
    serverId,
    'check_system_prerequisites'
  )
}
