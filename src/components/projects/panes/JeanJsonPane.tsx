import React, { useState, useCallback, useEffect } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  useJeanConfig,
  useSaveJeanConfig,
  normalizeRunScripts,
} from '@/services/projects'

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

export function JeanJsonPane({
  projectPath,
}: {
  projectId: string
  projectPath: string
}) {
  const { data: jeanConfig } = useJeanConfig(projectPath)
  const saveJeanConfig = useSaveJeanConfig()

  const [localSetup, setLocalSetup] = useState('')
  const [localTeardown, setLocalTeardown] = useState('')
  const [localRun, setLocalRun] = useState<string[]>([''])
  const [localPorts, setLocalPorts] = useState<
    { port: string; label: string }[]
  >([])
  const [synced, setSynced] = useState(false)

  // Sync from query data
  useEffect(() => {
    if (jeanConfig) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalSetup(jeanConfig.scripts.setup ?? '')
      setLocalTeardown(jeanConfig.scripts.teardown ?? '')
      const scripts = normalizeRunScripts(jeanConfig.scripts.run)
      setLocalRun(scripts.length > 0 ? scripts : [''])

      const ports = jeanConfig.ports ?? []
      setLocalPorts(ports.map(p => ({ port: String(p.port), label: p.label })))

      setSynced(true)
    }
  }, [jeanConfig])

  const originalRunScripts = normalizeRunScripts(jeanConfig?.scripts.run)
  const currentRunFiltered = localRun.filter(s => s.trim())
  const currentPortsFiltered = localPorts.filter(
    p => p.port.trim() && p.label.trim()
  )
  const originalPorts = (jeanConfig?.ports ?? []).map(p => ({
    port: String(p.port),
    label: p.label,
  }))

  const hasChanges = synced
    ? localSetup !== (jeanConfig?.scripts.setup ?? '') ||
      localTeardown !== (jeanConfig?.scripts.teardown ?? '') ||
      JSON.stringify(currentRunFiltered) !==
        JSON.stringify(originalRunScripts) ||
      JSON.stringify(currentPortsFiltered) !== JSON.stringify(originalPorts)
    : localSetup.trim() !== '' ||
      localTeardown.trim() !== '' ||
      currentRunFiltered.length > 0 ||
      currentPortsFiltered.length > 0

  const handleSave = useCallback(() => {
    const filtered = localRun.filter(s => s.trim())
    let run: string | string[] | null = null
    if (filtered.length === 1) run = filtered[0] ?? null
    else if (filtered.length > 1) run = filtered

    const validPorts = localPorts
      .filter(p => p.port.trim() && p.label.trim())
      .map(p => ({ port: Number(p.port), label: p.label.trim() }))
      .filter(p => !isNaN(p.port) && p.port > 0 && p.port <= 65535)

    saveJeanConfig.mutate({
      projectPath,
      config: {
        scripts: {
          setup: localSetup.trim() || null,
          teardown: localTeardown.trim() || null,
          run,
        },
        ports: validPorts.length > 0 ? validPorts : null,
      },
    })
  }, [
    localSetup,
    localTeardown,
    localRun,
    localPorts,
    projectPath,
    saveJeanConfig,
  ])

  return (
    <div className="space-y-6">
      <SettingsSection title="Automation Scripts">
        <p className="text-xs text-muted-foreground">
          Scripts from jean.json — setup runs after worktree creation, teardown
          before deletion, run launches via the run command
        </p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="setup-script" className="text-sm">
              Setup
            </Label>
            <Input
              id="setup-script"
              placeholder="e.g. npm install"
              value={localSetup}
              onChange={e => setLocalSetup(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Runs automatically after a new worktree is created
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Run</Label>
            {localRun.map((cmd, i) => (
              <div key={i} className="flex items-center gap-1">
                <Input
                  placeholder="e.g. npm run dev"
                  value={cmd}
                  onChange={e => {
                    const next = [...localRun]
                    next[i] = e.target.value
                    setLocalRun(next)
                  }}
                  className="font-mono text-sm"
                />
                {localRun.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() =>
                      setLocalRun(localRun.filter((_, j) => j !== i))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setLocalRun([...localRun, ''])}
            >
              <Plus className="mr-1 h-3 w-3" />
              Add command
            </Button>
            <p className="text-xs text-muted-foreground">
              Launches via the run command in the toolbar
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Ports</Label>
            {localPorts.map((entry, i) => (
              <div key={i} className="flex items-center gap-1">
                <Input
                  placeholder="Port"
                  type="number"
                  value={entry.port}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, port: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="font-mono text-sm w-24"
                />
                <Input
                  placeholder="Label"
                  value={entry.label}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, label: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() =>
                    setLocalPorts(localPorts.filter((_, j) => j !== i))
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                setLocalPorts([...localPorts, { port: '', label: '' }])
              }
            >
              <Plus className="mr-1 h-3 w-3" />
              Add port
            </Button>
            <p className="text-xs text-muted-foreground">
              Open configured ports in browser via CMD+O
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="teardown-script" className="text-sm">
              Teardown
            </Label>
            <Input
              id="teardown-script"
              placeholder="e.g. docker compose down"
              value={localTeardown}
              onChange={e => setLocalTeardown(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Runs automatically before a worktree is deleted/archived
            </p>
          </div>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p>
              <code className="text-foreground/80">$JEAN_WORKSPACE_PATH</code>
              {' — worktree directory'}
            </p>
            <p>
              <code className="text-foreground/80">$JEAN_ROOT_PATH</code>
              {' — repository root'}
            </p>
            <p>
              <code className="text-foreground/80">$JEAN_BRANCH</code>
              {' — branch name'}
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || saveJeanConfig.isPending}
          >
            {saveJeanConfig.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </div>
      </SettingsSection>
    </div>
  )
}
