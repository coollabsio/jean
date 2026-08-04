/**
 * WSL Mode Selection Step (Windows only)
 *
 * Shown at the very start of onboarding on Windows when WSL mode has not been chosen.
 * Lets users choose between "Native Windows" (default) and "WSL" development modes.
 */

import { useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePatchPreferences } from '@/services/preferences'
import { Loader2, CheckCircle2, XCircle, Monitor, Terminal } from 'lucide-react'

interface WslSetupStepProps {
  onComplete: () => void
}

type ValidationState = 'idle' | 'checking' | 'valid' | 'invalid'

export function WslSetupStep({ onComplete }: WslSetupStepProps) {
  const patchPreferences = usePatchPreferences()
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'native' | 'wsl'>('native')
  const [distros, setDistros] = useState<string[]>([])
  const [selectedDistro, setSelectedDistro] = useState('')
  const [loadingDistros, setLoadingDistros] = useState(false)
  const [validation, setValidation] = useState<ValidationState>('idle')
  const [validationMessage, setValidationMessage] = useState('')
  const [saving, setSaving] = useState(false)

  // Load available WSL distros when WSL mode is selected
  useEffect(() => {
    if (mode !== 'wsl') return
    let cancelled = false
    setLoadingDistros(true)
    invoke<string[]>('list_wsl_distros')
      .then(result => {
        if (cancelled) return
        setDistros(result)
        if (result.length === 1 && result[0]) {
          setSelectedDistro(result[0])
        }
      })
      .catch(() => {
        if (!cancelled) setDistros([])
      })
      .finally(() => {
        if (!cancelled) setLoadingDistros(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  // Validate selected distro has git
  useEffect(() => {
    if (mode !== 'wsl' || !selectedDistro) {
      setValidation('idle')
      setValidationMessage('')
      return
    }
    let cancelled = false
    setValidation('checking')
    setValidationMessage('Checking for git...')

    invoke<boolean>('check_wsl_tool', {
      distro: selectedDistro,
      tool: 'git',
    })
      .then(hasGit => {
        if (cancelled) return
        if (hasGit) {
          setValidation('valid')
          setValidationMessage('git found')
        } else {
          setValidation('invalid')
          setValidationMessage(
            'git not found. Install it inside WSL: sudo apt install git'
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setValidation('invalid')
          setValidationMessage('Failed to check WSL distro')
        }
      })
    return () => {
      cancelled = true
    }
  }, [mode, selectedDistro])

  const handleContinue = useCallback(async () => {
    setSaving(true)
    try {
      if (mode === 'native') {
        await patchPreferences.mutateAsync({
          wsl_mode_chosen: true,
          wsl_enabled: false,
          wsl_distro: '',
        })
      } else {
        await patchPreferences.mutateAsync({
          wsl_mode_chosen: true,
          wsl_enabled: true,
          wsl_distro: selectedDistro,
        })
      }
      // WSL mode affects where path-detection, status, and auth checks look
      // for each CLI — invalidate cached results so downstream onboarding
      // steps re-fetch against the new target (WSL distro vs Windows host).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['claude-cli'] }),
        queryClient.invalidateQueries({ queryKey: ['codex-cli'] }),
        queryClient.invalidateQueries({ queryKey: ['opencode-cli'] }),
        queryClient.invalidateQueries({ queryKey: ['gh-cli'] }),
      ])
      onComplete()
    } catch {
      // Toast will show from mutation error
    } finally {
      setSaving(false)
    }
  }, [mode, selectedDistro, patchPreferences, queryClient, onComplete])

  const canContinue =
    mode === 'native' || (mode === 'wsl' && validation === 'valid')

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h3 className="text-lg font-semibold">How do you develop?</h3>
        <p className="text-muted-foreground text-sm">
          Choose where your repos and tools live. You can change this later in
          preferences.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Native Windows card */}
        <button
          type="button"
          onClick={() => setMode('native')}
          className={`flex flex-col items-center gap-3 rounded-lg border-2 p-4 text-left transition-colors ${
            mode === 'native'
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-muted-foreground/30'
          }`}
        >
          <Monitor className="h-8 w-8 text-muted-foreground" />
          <div className="text-center">
            <div className="font-medium">Native Windows</div>
            <div className="text-muted-foreground mt-1 text-xs">
              Your repos and tools are on Windows
            </div>
          </div>
        </button>

        {/* WSL card */}
        <button
          type="button"
          onClick={() => setMode('wsl')}
          className={`flex flex-col items-center gap-3 rounded-lg border-2 p-4 text-left transition-colors ${
            mode === 'wsl'
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-muted-foreground/30'
          }`}
        >
          <Terminal className="h-8 w-8 text-muted-foreground" />
          <div className="text-center">
            <div className="flex items-center justify-center gap-1.5 font-medium">
              <span>WSL</span>
              <Badge
                variant="outline"
                className="rounded-sm border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0 text-[10px] leading-4 tracking-wide text-yellow-600 uppercase dark:text-yellow-400"
              >
                Beta
              </Badge>
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              Your repos and tools live inside WSL
            </div>
          </div>
        </button>
      </div>

      {/* WSL distro selection */}
      {mode === 'wsl' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="wsl-distribution"
              className="text-sm font-medium"
            >
              WSL Distribution
            </label>
            {loadingDistros ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading distributions...
              </div>
            ) : distros.length === 0 ? (
              <p className="text-sm text-destructive">
                No WSL distributions found. Install one first: wsl --install
              </p>
            ) : (
              <Select value={selectedDistro} onValueChange={setSelectedDistro}>
                <SelectTrigger id="wsl-distribution">
                  <SelectValue placeholder="Select a distribution" />
                </SelectTrigger>
                <SelectContent>
                  {distros.map(d => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Validation status */}
          {selectedDistro && validation !== 'idle' && (
            <div className="flex items-center gap-2 text-sm">
              {validation === 'checking' && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
              {validation === 'valid' && (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              )}
              {validation === 'invalid' && (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span
                className={
                  validation === 'invalid'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }
              >
                {validationMessage}
              </span>
            </div>
          )}
        </div>
      )}

      <Button
        className="w-full"
        onClick={handleContinue}
        disabled={!canContinue || saving}
      >
        {saving ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          'Continue'
        )}
      </Button>
    </div>
  )
}
