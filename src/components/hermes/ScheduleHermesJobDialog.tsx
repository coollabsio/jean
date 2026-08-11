/**
 * Schedule a Hermes cron job bound to a Jean worktree (product surface B).
 */

import { useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateHermesJobFromWorktree } from '@/services/hermes-cli'
import type { Worktree } from '@/types/projects'

const SCHEDULE_PRESETS: { value: string; label: string }[] = [
  { value: 'every 1h', label: 'Every hour' },
  { value: 'every 6h', label: 'Every 6 hours' },
  { value: 'every 1d', label: 'Every day' },
  { value: '0 9 * * *', label: 'Daily at 09:00 (cron)' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 09:00' },
  { value: 'custom', label: 'Custom…' },
]

interface ScheduleHermesJobDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktree: Worktree
}

export function ScheduleHermesJobDialog({
  open,
  onOpenChange,
  worktree,
}: ScheduleHermesJobDialogProps) {
  const createJob = useCreateHermesJobFromWorktree()
  const [name, setName] = useState(`${worktree.name} schedule`)
  const [preset, setPreset] = useState('every 1d')
  const [customSchedule, setCustomSchedule] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState(
    `In this worktree (${worktree.path}), summarize git status, open issues if relevant, and note anything that needs attention.`
  )

  const schedule = preset === 'custom' ? customSchedule : preset

  const handleSubmit = async () => {
    if (!schedule.trim() || !prompt.trim()) return
    await createJob.mutateAsync({
      worktreeId: worktree.id,
      name: name.trim() || worktree.name,
      schedule: schedule.trim(),
      prompt: prompt.trim(),
      deliver: 'local',
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Schedule Hermes job</DialogTitle>
          <DialogDescription>
            Creates a Hermes cron job with <code className="text-xs">workdir</code>{' '}
            set to this worktree. Jean installs/starts the Hermes gateway service
            so cron keeps running when Jean is closed (and for Discord/Telegram
            delivery if those platforms are configured on Hermes).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="hermes-job-name">Name</Label>
            <Input
              id="hermes-job-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Job name"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Schedule</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map(p => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {preset === 'custom' && (
              <Input
                value={customSchedule}
                onChange={e => setCustomSchedule(e.target.value)}
                placeholder='e.g. every 2h  or  0 9 * * *'
                className="mt-1"
              />
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="hermes-job-prompt">Prompt</Label>
            <Textarea
              id="hermes-job-prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={5}
              placeholder="Self-contained task for the scheduled agent…"
            />
          </div>

          <p className="text-muted-foreground text-xs break-all">
            Workdir: {worktree.path}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={
              createJob.isPending || !schedule.trim() || !prompt.trim()
            }
          >
            {createJob.isPending ? 'Scheduling…' : 'Schedule job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
