import { useEffect, useMemo, useState } from 'react'
import { Coffee } from 'lucide-react'
import type { Worktree } from '@/types/projects'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

interface StandbyWakeUpOption {
  label: string
  timestamp: number
}

function atNine(date: Date): Date {
  const result = new Date(date)
  result.setHours(9, 0, 0, 0)
  return result
}

function nextWeekdayAtNine(now: Date, weekday: number): Date {
  const result = atNine(now)
  let days = (weekday - result.getDay() + 7) % 7
  if (days === 0 && result.getTime() <= now.getTime()) days = 7
  result.setDate(result.getDate() + days)
  return result
}

export function getStandbyWakeUpOptions(
  now = new Date()
): StandbyWakeUpOption[] {
  const tomorrow = atNine(now)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const nextMonday = atNine(now)
  let daysUntilMonday = (1 - nextMonday.getDay() + 7) % 7
  if (daysUntilMonday === 0) daysUntilMonday = 7
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday)

  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + 7)

  return [
    {
      label: 'Demain à 9 h',
      timestamp: Math.floor(tomorrow.getTime() / 1000),
    },
    {
      label: 'Vendredi à 9 h',
      timestamp: Math.floor(nextWeekdayAtNine(now, 5).getTime() / 1000),
    },
    {
      label: 'Lundi prochain à 9 h',
      timestamp: Math.floor(nextMonday.getTime() / 1000),
    },
    {
      label: 'Dans une semaine',
      timestamp: Math.floor(nextWeek.getTime() / 1000),
    },
  ]
}

interface StandbyDialogProps {
  open: boolean
  worktree: Worktree
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string, standbyUntil: number) => void
}

export function StandbyDialog({
  open,
  worktree,
  isPending,
  onOpenChange,
  onConfirm,
}: StandbyDialogProps) {
  const options = useMemo(() => getStandbyWakeUpOptions(), [open, worktree.id])
  const [reason, setReason] = useState('')
  const [standbyUntil, setStandbyUntil] = useState(options[0]?.timestamp ?? 0)

  useEffect(() => {
    if (!open) return
    setReason(worktree.standby_reason ?? '')
    setStandbyUntil(options[0]?.timestamp ?? 0)
  }, [open, options, worktree.standby_reason])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const normalizedReason = reason.trim()
    if (!normalizedReason || !standbyUntil) return
    onConfirm(normalizedReason, standbyUntil)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                <Coffee className="size-4" />
              </span>
              <DialogTitle>Standby métier</DialogTitle>
            </div>
            <DialogDescription className="truncate">
              {worktree.name}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="standby-reason">Qu’est-ce que tu attends ?</Label>
            <Input
              id="standby-reason"
              autoFocus
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="Ex. validation de Sarah sur le mapping"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="standby-until">Quand le réveiller ?</Label>
            <NativeSelect
              id="standby-until"
              className="w-full"
              value={standbyUntil}
              onChange={event => setStandbyUntil(Number(event.target.value))}
            >
              {options.map(option => (
                <NativeSelectOption key={option.label} value={option.timestamp}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            Jean le sort du quotidien et le remonte automatiquement à
            l’échéance.
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Annuler
            </Button>
            <Button
              type="submit"
              disabled={!reason.trim() || !standbyUntil || isPending}
            >
              Mettre en standby
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
