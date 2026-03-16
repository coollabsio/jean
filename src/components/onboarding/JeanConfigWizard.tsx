import { useState } from 'react'
import { FileCode2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useProjectsStore } from '@/store/projects-store'
import { useProjects, useSaveJeanConfig } from '@/services/projects'
import { usePreferences, usePatchPreferences } from '@/services/preferences'

export function JeanConfigWizard() {
  const open = useProjectsStore(s => s.jeanConfigWizardOpen)

  if (!open) return null

  return <JeanConfigWizardContent />
}

function JeanConfigWizardContent() {
  const { jeanConfigWizardProjectId, closeJeanConfigWizard } =
    useProjectsStore()
  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === jeanConfigWizardProjectId)

  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const saveConfig = useSaveJeanConfig()

  const [setupScript, setSetupScript] = useState('')
  const [teardownScript, setTeardownScript] = useState('')
  const [runScript, setRunScript] = useState('')

  const markSeen = () => {
    if (preferences && !preferences.has_seen_jean_config_wizard) {
      patchPreferences.mutate({ has_seen_jean_config_wizard: true })
    }
  }

  const handleSave = async () => {
    if (!project?.path) return

    await saveConfig.mutateAsync({
      projectPath: project.path,
      config: {
        scripts: {
          setup: setupScript.trim() || null,
          teardown: teardownScript.trim() || null,
          run: runScript.trim() || null,
        },
      },
    })

    markSeen()
    closeJeanConfigWizard()
  }

  const handleSkip = () => {
    markSeen()
    closeJeanConfigWizard()
  }

  const hasContent = setupScript.trim() || teardownScript.trim() || runScript.trim()

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) handleSkip()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure Automation</DialogTitle>
          <DialogDescription>
            {project?.name
              ? `Set up automation scripts for ${project.name}`
              : 'Set up automation scripts for your project'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Education callout */}
          <div className="flex gap-3 rounded-lg border border-border/50 bg-muted/30 p-3">
            <FileCode2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                Jean uses a{' '}
                <code className="text-foreground/80">jean.json</code> file in
                your project root to automate repetitive tasks:
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>
                  <strong>Setup</strong> runs automatically when a new worktree
                  is created (e.g. installing dependencies)
                </li>
                <li>
                  <strong>Teardown</strong> runs before a worktree is deleted/archived
                  (e.g. stopping services)
                </li>
                <li>
                  <strong>Run</strong> launches your dev server via the run
                  command
                </li>
              </ul>
              <div className="space-y-0.5 pt-1">
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
            </div>
          </div>

          {/* Setup script */}
          <div className="space-y-1.5">
            <Label htmlFor="wizard-setup-script" className="text-sm">
              Setup Script
            </Label>
            <Input
              id="wizard-setup-script"
              placeholder="e.g. npm install"
              value={setupScript}
              onChange={e => setSetupScript(e.target.value)}
              className="font-mono text-sm"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Runs after each new worktree is created
            </p>
          </div>

          {/* Teardown script */}
          <div className="space-y-1.5">
            <Label htmlFor="wizard-teardown-script" className="text-sm">
              Teardown Script
            </Label>
            <Input
              id="wizard-teardown-script"
              placeholder="e.g. docker compose down"
              value={teardownScript}
              onChange={e => setTeardownScript(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Runs before each worktree is deleted
            </p>
          </div>

          {/* Run script */}
          <div className="space-y-1.5">
            <Label htmlFor="wizard-run-script" className="text-sm">
              Run Script
            </Label>
            <Input
              id="wizard-run-script"
              placeholder="e.g. npm run dev"
              value={runScript}
              onChange={e => setRunScript(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Launches your dev environment in the terminal
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleSkip}>
            Skip
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasContent || saveConfig.isPending}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
