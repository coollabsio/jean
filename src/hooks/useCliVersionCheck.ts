/**
 * CLI Version Check Hook
 *
 * Checks for CLI updates on application startup and shows toast notifications
 * with buttons to update directly.
 */

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  useClaudeCliStatus,
  useAvailableCliVersions,
  useClaudePathDetection,
} from '@/services/claude-cli'
import {
  useGhCliStatus,
  useAvailableGhVersions,
  useGhPathDetection,
} from '@/services/gh-cli'
import {
  useCodexCliStatus,
  useAvailableCodexVersions,
  useCodexPathDetection,
} from '@/services/codex-cli'
import {
  useOpencodeCliStatus,
  useAvailableOpencodeVersions,
  useOpencodePathDetection,
} from '@/services/opencode-cli'
import { useUIStore } from '@/store/ui-store'
import { isNewerVersion } from '@/lib/version-utils'
import { logger } from '@/lib/logger'
import { isNativeApp } from '@/lib/environment'
import { usePreferences } from '@/services/preferences'

interface CliUpdateInfo {
  type: 'claude' | 'gh' | 'codex' | 'opencode'
  currentVersion: string
  latestVersion: string
  cliSource?: 'jean' | 'path'
  cliPath?: string | null
  packageManager?: string | null
}

/** Map CLI type to the binary name used by the package manager */
const CLI_BINARY_NAMES: Record<CliUpdateInfo['type'], string> = {
  claude: 'claude-code',
  gh: 'gh',
  codex: 'codex',
  opencode: 'opencode',
}

/** Map CLI type to its npm package name (for npm-installed CLIs without self-update) */
const NPM_PACKAGE_NAMES: Partial<Record<CliUpdateInfo['type'], string>> = {
  codex: '@openai/codex',
}

const CLI_DISPLAY_NAMES: Record<CliUpdateInfo['type'], string> = {
  claude: 'Claude CLI',
  gh: 'GitHub CLI',
  codex: 'Codex CLI',
  opencode: 'OpenCode CLI',
}

/**
 * Hook that checks for CLI updates on startup and periodically (every hour).
 * Shows toast notifications when updates are detected.
 * Should be called once in App.tsx.
 */
export function useCliVersionCheck() {
  const shouldCheck = isNativeApp()
  const { data: preferences } = usePreferences()
  const { data: claudePathInfo } = useClaudePathDetection({
    enabled: shouldCheck,
  })
  const { data: ghPathInfo } = useGhPathDetection({ enabled: shouldCheck })
  const { data: codexPathInfo } = useCodexPathDetection({
    enabled: shouldCheck,
  })
  const { data: opencodePathInfo } = useOpencodePathDetection({
    enabled: shouldCheck,
  })

  // Defer version fetches (GitHub API) by 10s — they're only for update toasts,
  // no reason to compete with startup-critical queries.
  const [versionCheckReady, setVersionCheckReady] = useState(false)
  useEffect(() => {
    if (!shouldCheck) return
    const timer = setTimeout(() => setVersionCheckReady(true), 10_000)
    return () => clearTimeout(timer)
  }, [shouldCheck])

  const { data: claudeStatus, isLoading: claudeLoading } = useClaudeCliStatus({
    enabled: shouldCheck && versionCheckReady,
  })
  const { data: ghStatus, isLoading: ghLoading } = useGhCliStatus({
    enabled: shouldCheck && versionCheckReady,
  })
  const { data: codexStatus, isLoading: codexLoading } = useCodexCliStatus({
    enabled: shouldCheck && versionCheckReady,
  })
  const { data: opencodeStatus, isLoading: opencodeLoading } =
    useOpencodeCliStatus({ enabled: shouldCheck && versionCheckReady })
  const { data: claudeVersions, isLoading: claudeVersionsLoading } =
    useAvailableCliVersions({ enabled: shouldCheck && versionCheckReady })
  const { data: ghVersions, isLoading: ghVersionsLoading } =
    useAvailableGhVersions({ enabled: shouldCheck && versionCheckReady })
  const { data: codexVersions, isLoading: codexVersionsLoading } =
    useAvailableCodexVersions({ enabled: shouldCheck && versionCheckReady })
  const { data: opencodeVersions, isLoading: opencodeVersionsLoading } =
    useAvailableOpencodeVersions({ enabled: shouldCheck && versionCheckReady })

  // Track which update pairs we've already shown notifications for
  // Format: "type:currentVersion→latestVersion"
  const notifiedRef = useRef<Set<string>>(new Set())
  const isInitialCheckRef = useRef(true)

  useEffect(() => {
    // Wait until all data is loaded
    const isLoading =
      claudeLoading ||
      ghLoading ||
      codexLoading ||
      opencodeLoading ||
      claudeVersionsLoading ||
      ghVersionsLoading ||
      codexVersionsLoading ||
      opencodeVersionsLoading
    if (isLoading) return

    const updates: CliUpdateInfo[] = []

    // Check Claude CLI
    if (
      claudeStatus?.installed &&
      claudeStatus.version &&
      claudeVersions?.length
    ) {
      const latestStable = claudeVersions.find(v => !v.prerelease)
      if (
        latestStable &&
        isNewerVersion(latestStable.version, claudeStatus.version)
      ) {
        const key = `claude:${claudeStatus.version}→${latestStable.version}`
        if (!notifiedRef.current.has(key)) {
          notifiedRef.current.add(key)
          updates.push({
            type: 'claude',
            currentVersion: claudeStatus.version,
            latestVersion: latestStable.version,
            cliSource: preferences?.claude_cli_source,
            cliPath: claudeStatus.path,
            packageManager: claudePathInfo?.package_manager,
          })
        }
      }
    }

    // Check GitHub CLI
    if (ghStatus?.installed && ghStatus.version && ghVersions?.length) {
      const latestStable = ghVersions.find(v => !v.prerelease)
      if (
        latestStable &&
        isNewerVersion(latestStable.version, ghStatus.version)
      ) {
        const key = `gh:${ghStatus.version}→${latestStable.version}`
        if (!notifiedRef.current.has(key)) {
          notifiedRef.current.add(key)
          updates.push({
            type: 'gh',
            currentVersion: ghStatus.version,
            latestVersion: latestStable.version,
            cliSource: preferences?.gh_cli_source,
            cliPath: ghStatus.path,
            packageManager: ghPathInfo?.package_manager,
          })
        }
      }
    }

    // Check Codex CLI
    if (
      codexStatus?.installed &&
      codexStatus.version &&
      codexVersions?.length
    ) {
      const latestStable = codexVersions.find(v => !v.prerelease)
      if (
        latestStable &&
        isNewerVersion(latestStable.version, codexStatus.version)
      ) {
        const key = `codex:${codexStatus.version}→${latestStable.version}`
        if (!notifiedRef.current.has(key)) {
          notifiedRef.current.add(key)
          updates.push({
            type: 'codex',
            currentVersion: codexStatus.version,
            latestVersion: latestStable.version,
            cliSource: preferences?.codex_cli_source,
            cliPath: codexStatus.path,
            packageManager: codexPathInfo?.package_manager,
          })
        }
      }
    }

    // Check OpenCode CLI
    if (
      opencodeStatus?.installed &&
      opencodeStatus.version &&
      opencodeVersions?.length
    ) {
      const latestStable = opencodeVersions.find(v => !v.prerelease)
      if (
        latestStable &&
        isNewerVersion(latestStable.version, opencodeStatus.version)
      ) {
        const key = `opencode:${opencodeStatus.version}→${latestStable.version}`
        if (!notifiedRef.current.has(key)) {
          notifiedRef.current.add(key)
          updates.push({
            type: 'opencode',
            currentVersion: opencodeStatus.version,
            latestVersion: latestStable.version,
            cliSource: preferences?.opencode_cli_source,
            cliPath: opencodeStatus.path,
            packageManager: opencodePathInfo?.package_manager,
          })
        }
      }
    }

    if (updates.length > 0) {
      logger.info('CLI updates available', { updates })

      if (isInitialCheckRef.current) {
        // Delay initial notification to let the app settle
        setTimeout(() => {
          showUpdateToasts(updates)
        }, 5000)
      } else {
        showUpdateToasts(updates)
      }
    }

    isInitialCheckRef.current = false
  }, [
    claudeStatus,
    ghStatus,
    codexStatus,
    opencodeStatus,
    claudeVersions,
    ghVersions,
    codexVersions,
    opencodeVersions,
    claudeLoading,
    ghLoading,
    codexLoading,
    opencodeLoading,
    claudeVersionsLoading,
    ghVersionsLoading,
    codexVersionsLoading,
    opencodeVersionsLoading,
    preferences?.claude_cli_source,
    preferences?.codex_cli_source,
    preferences?.opencode_cli_source,
    preferences?.gh_cli_source,
  ])
}

/** Get the correct self-update args for each CLI type, or null if no built-in update */
function getPathModeUpdateArgs(type: CliUpdateInfo['type']): string[] | null {
  switch (type) {
    case 'claude':
      return ['update']
    case 'opencode':
      return ['upgrade']
    // gh and codex have no built-in self-update command
    default:
      return null
  }
}

/**
 * Show toast notifications for each CLI update.
 * Each CLI gets its own toast with Update and Cancel buttons.
 * Toast stays visible until user dismisses it.
 */
function showUpdateToasts(updates: CliUpdateInfo[]) {
  const { openCliUpdateModal, openCliLoginModal } = useUIStore.getState()

  for (const update of updates) {
    const cliName = CLI_DISPLAY_NAMES[update.type]
    const toastId = `cli-update-${update.type}`

    const isPathMode = update.cliSource === 'path'
    const isHomebrew = update.packageManager === 'homebrew'

    toast.info(`${cliName} update available`, {
      id: toastId,
      description: `v${update.currentVersion} → v${update.latestVersion}`,
      duration: Infinity, // Don't auto-dismiss
      action: {
        label: 'Update',
        onClick: () => {
          if (isPathMode && isHomebrew) {
            const brewPkg = CLI_BINARY_NAMES[update.type]
            logger.debug(
              `[CliVersionCheck] Homebrew update: brew upgrade ${brewPkg}`
            )
            openCliLoginModal(
              update.type,
              'brew',
              ['upgrade', brewPkg],
              'update'
            )
          } else if (isPathMode && update.cliPath) {
            const pathUpdateArgs = getPathModeUpdateArgs(update.type)
            if (pathUpdateArgs) {
              logger.debug(
                `[CliVersionCheck] PATH-mode update: type=${update.type} path=${update.cliPath} args=${pathUpdateArgs}`
              )
              openCliLoginModal(
                update.type,
                update.cliPath,
                pathUpdateArgs,
                'update'
              )
            } else if (update.packageManager === 'npm') {
              const npmPkg = NPM_PACKAGE_NAMES[update.type]
              if (npmPkg) {
                logger.debug(
                  `[CliVersionCheck] npm update: npm install -g ${npmPkg}@${update.latestVersion}`
                )
                openCliLoginModal(
                  update.type,
                  'npm',
                  ['install', '-g', `${npmPkg}@${update.latestVersion}`],
                  'update'
                )
              } else {
                openCliUpdateModal(update.type)
              }
            } else {
              openCliUpdateModal(update.type)
            }
          } else {
            openCliUpdateModal(update.type)
          }
          toast.dismiss(toastId)
        },
      },
      cancel: {
        label: 'Cancel',
        onClick: () => {
          toast.dismiss(toastId)
        },
      },
    })
  }
}
