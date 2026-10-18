import * as React from 'react'
import { ChevronDownIcon } from '@/components/icons/reicon'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface DatePickerProps {
  value?: Date
  onChange?: (date: Date | undefined) => void
  placeholder?: string
  className?: string
}

function DatePicker({
  value,
  onChange,
  placeholder = 'Select date',
  className,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={`w-full justify-between font-normal ${className || ''}`}
        >
          {value ? value.toLocaleDateString() : placeholder}
          <ChevronDownIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          captionLayout="dropdown"
          onSelect={date => {
            onChange?.(date)
            setOpen(false)
          }}
        />
        {value && (
          <div className="border-t p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                onChange?.(undefined)
                setOpen(false)
              }}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker }
