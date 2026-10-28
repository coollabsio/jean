import { Button } from '@/components/ui/button'
import { FolderPlus, Sparkles } from '@/components/icons/reicon'
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
        <p className="text-sm text-muted-foreground">
          Ready: {readyClis.map(cliLabel).join(', ')}
        </p>
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
