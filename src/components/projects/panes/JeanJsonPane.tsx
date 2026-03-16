import React, { useState, useCallback, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useJeanConfig, useSaveJeanConfig } from '@/services/projects'

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
  const [localRun, setLocalRun] = useState('')
  const [synced, setSynced] = useState(false)

  // Sync from query data
  useEffect(() => {
    if (jeanConfig) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalSetup(jeanConfig.scripts.setup ?? '')
      setLocalTeardown(jeanConfig.scripts.teardown ?? '')
      setLocalRun(jeanConfig.scripts.run ?? '')

      setSynced(true)
    }
  }, [jeanConfig])

  const hasChanges = synced
    ? localSetup !== (jeanConfig?.scripts.setup ?? '') ||
      localTeardown !== (jeanConfig?.scripts.teardown ?? '') ||
      localRun !== (jeanConfig?.scripts.run ?? '')
    : localSetup.trim() !== '' ||
      localTeardown.trim() !== '' ||
      localRun.trim() !== ''

  const handleSave = useCallback(() => {
    saveJeanConfig.mutate({
      projectPath,
      config: {
        scripts: {
          setup: localSetup.trim() || null,
          teardown: localTeardown.trim() || null,
          run: localRun.trim() || null,
        },
      },
    })
  }, [localSetup, localTeardown, localRun, projectPath, saveJeanConfig])

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
            <Label htmlFor="run-script" className="text-sm">
              Run
            </Label>
            <Input
              id="run-script"
              placeholder="e.g. npm run dev"
              value={localRun}
              onChange={e => setLocalRun(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Launches via the run command in the toolbar
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
