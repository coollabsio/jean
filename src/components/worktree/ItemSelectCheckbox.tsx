import { Checkbox } from '@/components/ui/checkbox'

export interface ItemSelectCheckboxProps {
  checked: boolean
  disabled?: boolean
  ariaLabel: string
  onCheckedChange: (checked: boolean) => void
}

/**
 * Touch-friendly row checkbox for New Session multi-select lists.
 * Aligns with status icons (`h-4 w-4 mt-0.5`) and first-line text; hit area
 * expands via padding without shifting the visual box.
 */
export function ItemSelectCheckbox({
  checked,
  disabled,
  ariaLabel,
  onCheckedChange,
}: ItemSelectCheckboxProps) {
  return (
    <div
      className="shrink-0 -ml-2 -mt-2 -mb-2 -mr-1 p-2 flex items-start"
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={value => onCheckedChange(value === true)}
        aria-label={ariaLabel}
        className="size-4 mt-0.5"
      />
    </div>
  )
}

export interface SelectAllControlProps {
  id: string
  allChecked: boolean
  someChecked: boolean
  onToggleAll: (checked: boolean) => void
  label?: string
  ariaLabel?: string
  /** Leading middle-dot separator (for filter rows that already have other controls). */
  showSeparator?: boolean
}

/** Compact "Select all" checkbox + label for list filter rows. */
export function SelectAllControl({
  id,
  allChecked,
  someChecked,
  onToggleAll,
  label = 'Select all',
  ariaLabel = 'Select all visible items',
  showSeparator = true,
}: SelectAllControlProps) {
  return (
    <>
      {showSeparator && (
        <span className="text-muted-foreground/40 text-xs">·</span>
      )}
      <Checkbox
        id={id}
        checked={allChecked ? true : someChecked ? 'indeterminate' : false}
        onCheckedChange={checked => onToggleAll(checked === true)}
        aria-label={ariaLabel}
      />
      <label
        htmlFor={id}
        className="text-xs text-muted-foreground cursor-pointer"
      >
        {label}
      </label>
    </>
  )
}
