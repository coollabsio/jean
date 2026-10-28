import { SettingsSection } from '@/components/preferences/SettingsSection'
import { InlineField } from '@/components/preferences/InlineField'
import { useState, useCallback, useEffect } from 'react'
import { ChevronRight, Loader2, Plus, X } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { generateId } from '@/lib/uuid'
import {
  useJeanConfig,
  useSaveJeanConfig,
  normalizeRunScripts,
} from '@/services/projects'

export function JeanJsonPane({
  projectPath,
}: {
  projectId: string
  projectPath: string
}) {
  const { data: jeanConfig, isLoading: isConfigLoading } =
    useJeanConfig(projectPath)
  const saveJeanConfig = useSaveJeanConfig()

  const [localSetup, setLocalSetup] = useState('')
  const [localTeardown, setLocalTeardown] = useState('')
  const [localRun, setLocalRun] = useState<{ id: string; value: string }[]>(
    () => [{ id: generateId(), value: '' }]
  )
  const [localPorts, setLocalPorts] = useState<
    { id: string; port: string; label: string; host: string }[]
  >([])
  const [synced, setSynced] = useState(false)

  // Sync from query data
  useEffect(() => {
    if (jeanConfig) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalSetup(jeanConfig.scripts.setup ?? '')
      setLocalTeardown(jeanConfig.scripts.teardown ?? '')
      const scripts = normalizeRunScripts(jeanConfig.scripts.run)
      setLocalRun(
        (scripts.length > 0 ? scripts : ['']).map(value => ({
          id: generateId(),
          value,
        }))
      )

      const ports = jeanConfig.ports ?? []
      setLocalPorts(
        ports.map(p => ({
          id: generateId(),
          port: String(p.port),
          label: p.label,
          host: p.host ?? '',
        }))
      )

      setSynced(true)
    }
  }, [jeanConfig])

  const originalRunScripts = normalizeRunScripts(jeanConfig?.scripts.run)
  const currentRunFiltered: string[] = []
  for (const s of localRun) {
    if (s.value.trim()) currentRunFiltered.push(s.value)
  }
  const currentPortsFiltered: { port: string; label: string; host: string }[] =
    []
  for (const p of localPorts) {
    if (p.port.trim() && p.label.trim()) {
      currentPortsFiltered.push({
        port: p.port,
        label: p.label,
        host: p.host,
      })
    }
  }
  const originalPorts = (jeanConfig?.ports ?? []).map(p => ({
    port: String(p.port),
    label: p.label,
    host: p.host ?? '',
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
    const filtered: string[] = []
    for (const s of localRun) {
      if (s.value.trim()) filtered.push(s.value)
    }
    let run: string | string[] | null = null
    if (filtered.length === 1) run = filtered[0] ?? null
    else if (filtered.length > 1) run = filtered

    const validPorts = localPorts.flatMap(p => {
      if (!p.port.trim() || !p.label.trim()) return []
      const port = Number(p.port)
      if (isNaN(port) || port <= 0 || port > 65535) return []
      return [
        {
          port,
          label: p.label.trim(),
          host: p.host.trim() || undefined,
        },
      ]
    })

    saveJeanConfig.mutate({
      projectPath,
      config: {
        // Preserve any fields this pane doesn't manage (e.g. provider binding).
        ...jeanConfig,
        scripts: {
          setup: localSetup.trim() || null,
          teardown: localTeardown.trim() || null,
          run,
        },
        ports: validPorts.length > 0 ? validPorts : null,
      },
    })
  }, [
    jeanConfig,
    localSetup,
    localTeardown,
    localRun,
    localPorts,
    projectPath,
    saveJeanConfig,
  ])

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Automation Scripts"
        description="Stored in jean.json in the project root"
      >
        <div className="space-y-4">
          <InlineField
            label="Setup"
            description="Runs after a new worktree is created"
            htmlFor="setup-script"
            layout="stacked"
          >
            <Input
              id="setup-script"
              placeholder="e.g. npm install"
              value={localSetup}
              onChange={e => setLocalSetup(e.target.value)}
              className="font-mono text-base md:text-sm"
            />
          </InlineField>
          <InlineField
            label="Run"
            description="Launched from the run command in the toolbar"
            layout="stacked"
          >
            {localRun.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-1">
                <Input
                  placeholder="e.g. npm run dev"
                  value={entry.value}
                  onChange={e => {
                    const next = [...localRun]
                    next[i] = { ...entry, value: e.target.value }
                    setLocalRun(next)
                  }}
                  className="font-mono text-base md:text-sm"
                />
                {localRun.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label="Remove command"
                    onClick={() =>
                      setLocalRun(localRun.filter(s => s.id !== entry.id))
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
              onClick={() =>
                setLocalRun([...localRun, { id: generateId(), value: '' }])
              }
            >
              <Plus className="mr-1 h-3 w-3" />
              Add command
            </Button>
          </InlineField>
          <InlineField
            label="Ports"
            description="Open in the browser with CMD+O"
            help="Leave host blank to use this server's default preview hostname, or localhost."
            layout="stacked"
          >
            {localPorts.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-1">
                <Input
                  placeholder="Port"
                  type="number"
                  value={entry.port}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, port: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="font-mono text-base md:text-sm w-24"
                />
                <Input
                  placeholder="Host (optional)"
                  value={entry.host}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, host: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="font-mono text-base md:text-sm w-40"
                />
                <Input
                  placeholder="Label"
                  value={entry.label}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, label: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="text-base md:text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label="Remove port"
                  onClick={() =>
                    setLocalPorts(localPorts.filter(p => p.id !== entry.id))
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
                setLocalPorts([
                  ...localPorts,
                  {
                    id: generateId(),
                    port: '',
                    label: '',
                    host: '',
                  },
                ])
              }
            >
              <Plus className="mr-1 h-3 w-3" />
              Add port
            </Button>
          </InlineField>
          <InlineField
            label="Teardown"
            description="Runs before a worktree is deleted or archived"
            htmlFor="teardown-script"
            layout="stacked"
          >
            <Input
              id="teardown-script"
              placeholder="e.g. docker compose down"
              value={localTeardown}
              onChange={e => setLocalTeardown(e.target.value)}
              className="font-mono text-base md:text-sm"
            />
          </InlineField>
          <Collapsible>
            <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              Environment variables
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <dt>
                  <code className="text-foreground/80">
                    $JEAN_WORKSPACE_PATH
                  </code>
                </dt>
                <dd>Worktree directory</dd>
                <dt>
                  <code className="text-foreground/80">$JEAN_ROOT_PATH</code>
                </dt>
                <dd>Repository root</dd>
                <dt>
                  <code className="text-foreground/80">$JEAN_BRANCH</code>
                </dt>
                <dd>Branch name</dd>
              </dl>
            </CollapsibleContent>
          </Collapsible>
          <Button
            size="sm"
            onClick={handleSave}
            // Wait for the existing config to load before saving so we don't
            // spread `undefined` and drop fields this pane doesn't manage
            // (e.g. a `provider` block).
            disabled={
              !hasChanges || saveJeanConfig.isPending || isConfigLoading
            }
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
