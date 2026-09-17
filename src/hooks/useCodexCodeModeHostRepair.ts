import { useEffect, useRef } from 'react'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'

/** Repair managed Codex installs created before the code-mode host was bundled. */
export function useCodexCodeModeHostRepair(installed: boolean): void {
  const attemptedRef = useRef(false)

  useEffect(() => {
    if (!installed || attemptedRef.current) return
    attemptedRef.current = true

    void invoke('install_missing_codex_code_mode_host').catch(error => {
      logger.warn('Failed to install missing Codex code-mode host', { error })
    })
  }, [installed])
}
