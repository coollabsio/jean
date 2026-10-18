import { Button } from '@/components/ui/button'
import { FolderPlus, Github, Sparkles } from '@/components/icons/reicon'
import { getBackendIcon } from '@/components/ui/backend-label'
import { cliLabel, type CliType } from './cli-setup-flows'

interface SuccessStepProps {
  readyClis: CliType[]
  busy: boolean
  onAddProject: () => void
  onTour: () => void
}

export function SuccessStep({
  readyClis,
  busy,
  onAddProject,
  onTour,
}: SuccessStepProps) {
  return (
    <div className="space-y-6">
      {readyClis.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Ready tools">
          {readyClis.map(cli => {
            const Icon = cli === 'gh' ? Github : getBackendIcon(cli)
            return (
              <li
                key={cli}
                className="flex items-center gap-1.5 rounded-lg border bg-primary/5 px-2.5 py-1 text-xs"
              >
                <Icon className="size-3.5" />
                {cliLabel(cli)}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" onClick={onAddProject} disabled={busy}>
          <FolderPlus className="mr-2 size-4" />
          Add a project
        </Button>
        <Button
          className="flex-1"
          variant="outline"
          onClick={onTour}
          disabled={busy}
        >
          <Sparkles className="mr-2 size-4" />
          Take the tour
        </Button>
      </div>
    </div>
  )
}
