/**
 * CLI Reinstall Modal
 *
 * Simple modal for installing or updating a single CLI (Claude or GitHub).
 * Used from Advanced Settings when user wants to change CLI version.
 * Separate from OnboardingDialog which handles the combined first-time setup flow.
 *
 * Architecture:
 * - ClaudeCliReinstallModal: Calls ONLY useClaudeCliSetup (no duplicate listeners)
 * - GhCliReinstallModal: Calls ONLY useGhCliSetup (no duplicate listeners)
 * - CliReinstallModalUI: Shared UI component, receives setup as prop
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CheckCircle2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useClaudeCliSetup } from '@/services/claude-cli'
import { useGhCliSetup } from '@/services/gh-cli'
import { useCodexCliSetup } from '@/services/codex-cli'
import { useOpenCodeCliSetup } from '@/services/opencode-cli'
import { logger } from '@/lib/logger'
import {
  SetupState,
  InstallingState,
  ErrorState,
} from '@/components/onboarding/CliSetupComponents'

/**
 * Common interface for CLI setup objects (both hooks return compatible shapes)
 */
interface CliSetupInterface {
  status:
    | { installed?: boolean; version?: string | null; path?: string | null }
    | undefined
  versions: { version: string; prerelease: boolean }[]
  isVersionsLoading: boolean
  progress: { stage: string; message: string; percent: number } | null
  install: (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => void
  refetchStatus: () => void
}

interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ModalStep = 'setup' | 'installing' | 'complete'

/**
 * Claude CLI specific modal - calls ONLY useClaudeCliSetup
 * This ensures only one event listener is active
 */
export function ClaudeCliReinstallModal({ open, onOpenChange }: ModalProps) {
  if (!open) return null
  return (
    <ClaudeCliReinstallModalContent open={open} onOpenChange={onOpenChange} />
  )
}

function ClaudeCliReinstallModalContent({ open, onOpenChange }: ModalProps) {
  const setup = useClaudeCliSetup()
  return (
    <CliReinstallModalUI
      setup={setup}
      cliType="claude"
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}

/**
 * GitHub CLI specific modal - calls ONLY useGhCliSetup
 * This ensures only one event listener is active
 */
export function GhCliReinstallModal({ open, onOpenChange }: ModalProps) {
  if (!open) return null
  return <GhCliReinstallModalContent open={open} onOpenChange={onOpenChange} />
}

function GhCliReinstallModalContent({ open, onOpenChange }: ModalProps) {
  const setup = useGhCliSetup()
  return (
    <CliReinstallModalUI
      setup={setup}
      cliType="gh"
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}

/**
 * Codex CLI specific modal - calls ONLY useCodexCliSetup
 * This ensures only one event listener is active
 */
export function CodexCliReinstallModal({ open, onOpenChange }: ModalProps) {
  if (!open) return null
  return (
    <CodexCliReinstallModalContent open={open} onOpenChange={onOpenChange} />
  )
}

function CodexCliReinstallModalContent({ open, onOpenChange }: ModalProps) {
  const setup = useCodexCliSetup()
  return (
    <CliReinstallModalUI
      setup={setup}
      cliType="codex"
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}

/**
 * OpenCode CLI specific modal - calls ONLY useOpenCodeCliSetup
 * This ensures only one event listener is active
 */
export function OpenCodeCliReinstallModal({ open, onOpenChange }: ModalProps) {
  if (!open) return null
  return (
    <OpenCodeCliReinstallModalContent open={open} onOpenChange={onOpenChange} />
  )
}

function OpenCodeCliReinstallModalContent({ open, onOpenChange }: ModalProps) {
  const setup = useOpenCodeCliSetup()
  return (
    <CliReinstallModalUI
      setup={setup}
      cliType="opencode"
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}

/**
 * Shared UI component - receives setup as prop, no hooks here
 */
interface CliReinstallModalUIProps {
  setup: CliSetupInterface
  cliType: 'claude' | 'gh' | 'codex' | 'opencode'
  open: boolean
  onOpenChange: (open: boolean) => void
}

function CliReinstallModalUI({
  setup,
  cliType,
  open,
  onOpenChange,
}: CliReinstallModalUIProps) {
  const cliName =
    cliType === 'claude'
      ? 'Claude CLI'
      : cliType === 'codex'
        ? 'Codex CLI'
        : cliType === 'opencode'
          ? 'OpenCode CLI'
          : 'GitHub CLI'

  // Store setup in ref for stable callback reference
  const setupRef = useRef(setup)
  useEffect(() => {
    setupRef.current = setup
  }, [setup])

  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [step, setStep] = useState<ModalStep>('setup')
  const [installError, setInstallError] = useState<Error | null>(null)
  // Guard against double-invocation
  const isInstallingRef = useRef(false)

  // Filter to stable releases only
  const stableVersions = useMemo(
    () => setup.versions.filter(v => !v.prerelease),
    [setup.versions]
  )

  const latestStableVersion = stableVersions[0]?.version ?? null

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      queueMicrotask(() => {
        setStep('setup')
        setInstallError(null)
        setSelectedVersion(latestStableVersion)
        isInstallingRef.current = false
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Auto-select version when versions load
  useEffect(() => {
    if (open && !selectedVersion && latestStableVersion) {
      queueMicrotask(() => {
        setSelectedVersion(latestStableVersion)
      })
    }
  }, [open, selectedVersion, latestStableVersion])

  const handleInstall = useCallback(() => {
    logger.info('[CliReinstallModal] handleInstall called', {
      cliType,
      selectedVersion,
      isInstallingRef: isInstallingRef.current,
    })

    if (!selectedVersion) {
      logger.warn('[CliReinstallModal] No version selected, aborting')
      return
    }
    // Guard against double-invocation
    if (isInstallingRef.current) {
      logger.warn(
        '[CliReinstallModal] Already installing, aborting duplicate call'
      )
      return
    }
    isInstallingRef.current = true

    logger.info('[CliReinstallModal] Starting installation', {
      cliType,
      selectedVersion,
    })
    setStep('installing')
    setInstallError(null)

    setupRef.current.install(selectedVersion, {
      onSuccess: () => {
        logger.info('[CliReinstallModal] Installation succeeded', { cliType })
        isInstallingRef.current = false
        setupRef.current.refetchStatus()
        setStep('complete')
      },
      onError: error => {
        logger.error('[CliReinstallModal] Installation failed', {
          cliType,
          error,
        })
        isInstallingRef.current = false
        setInstallError(error)
        setStep('setup')
      },
    })
  }, [selectedVersion, cliType])

  const handleComplete = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const isReinstall = setup.status?.installed

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]" preventClose>
        <DialogHeader>
          <DialogTitle>
            {step === 'complete'
              ? 'Installation Complete'
              : isReinstall
                ? `Update ${cliName}`
                : `Install ${cliName}`}
          </DialogTitle>
          <DialogDescription>
            {step === 'complete'
              ? `${cliName} has been successfully installed.`
              : isReinstall
                ? 'Select a version to install. This will replace the current installation.'
                : `${cliName} is required for ${cliType === 'claude' ? 'AI chat functionality' : cliType === 'codex' ? 'Codex AI sessions' : cliType === 'opencode' ? 'OpenCode AI sessions' : 'GitHub integration'}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {step === 'complete' ? (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-4">
                <CheckCircle2 className="size-10 text-green-500" />
                <div className="text-center">
                  <p className="font-medium">Installation Successful</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {cliName}: v{selectedVersion}
                  </p>
                </div>
              </div>
              <Button onClick={handleComplete} className="w-full" size="lg">
                Done
              </Button>
            </div>
          ) : step === 'installing' ? (
            <InstallingState cliName={cliName} progress={setup.progress} />
          ) : installError ? (
            <ErrorState
              cliName={cliName}
              error={installError}
              onRetry={handleInstall}
            />
          ) : (
            <SetupState
              cliName={cliName}
              versions={stableVersions}
              selectedVersion={selectedVersion}
              currentVersion={isReinstall ? setup.status?.version : null}
              isLoading={setup.isVersionsLoading}
              onVersionChange={setSelectedVersion}
              onInstall={handleInstall}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
