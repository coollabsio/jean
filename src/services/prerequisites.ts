import { invoke } from '@tauri-apps/api/core'

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

export function checkSystemPrerequisites() {
  return invoke<SystemPrerequisites>('check_system_prerequisites')
}
