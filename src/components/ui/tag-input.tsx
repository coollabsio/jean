import * as React from 'react'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { generateId } from '@/lib/uuid'
import { Badge } from './badge'

export interface Tag {
  id: string
  text: string
}

export interface TagInputProps
  extends Omit<React.ComponentProps<'div'>, 'onChange'> {
  tags: Tag[]
  onTagsChange: (tags: Tag[]) => void
  placeholder?: string
  maxTags?: number
  allowDuplicates?: boolean
  disabled?: boolean
}

const TagInput = React.forwardRef<HTMLDivElement, TagInputProps>(
  (
    {
      className,
      tags,
      onTagsChange,
      placeholder = 'Add a tag...',
      maxTags,
      allowDuplicates = false,
      disabled = false,
      ...props
    },
    ref
  ) => {
    const [inputValue, setInputValue] = React.useState('')
    const inputRef = React.useRef<HTMLInputElement>(null)

    const addTag = (value: string) => {
      const trimmedValue = value.trim()
      if (!trimmedValue) return

      // Check for duplicates if not allowed
      if (!allowDuplicates && tags.some(tag => tag.text === trimmedValue)) {
        setInputValue('')
        return
      }

      // Check max tags limit
      if (maxTags && tags.length >= maxTags) {
        setInputValue('')
        return
      }

      const newTag: Tag = {
        id: generateId(),
        text: trimmedValue,
      }

      onTagsChange([...tags, newTag])
      setInputValue('')
    }

    const removeTag = (tagId: string) => {
      onTagsChange(tags.filter(tag => tag.id !== tagId))
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (disabled) return

      if (e.key === 'Enter' && inputValue.trim()) {
        e.preventDefault()
        addTag(inputValue)
      } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
        e.preventDefault()
        const lastTag = tags[tags.length - 1]
        if (lastTag) {
          removeTag(lastTag.id)
        }
      } else if (e.key === 'Escape') {
        setInputValue('')
        inputRef.current?.blur()
      }
    }

    const handleContainerClick = () => {
      if (!disabled && inputRef.current) {
        inputRef.current.focus()
      }
    }

    return (
      <div
        ref={ref}
        className={cn(
          'border-input placeholder:text-muted-foreground focus-within:border-ring focus-within:ring-ring/50 flex min-h-9 w-full rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] focus-within:ring-[3px] md:text-sm',
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
        onClick={handleContainerClick}
        {...props}
      >
        <div className="flex flex-1 flex-wrap items-center gap-1 py-1">
          {tags.map(tag => (
            <Badge
              key={tag.id}
              variant="secondary"
              className="text-xs px-2 py-0.5"
            >
              {tag.text}
              {!disabled && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    removeTag(tag.id)
                  }}
                  className="ml-1 hover:bg-destructive/20 rounded-sm p-0.5 transition-colors"
                  aria-label={`Remove ${tag.text} tag`}
                >
                  <X className="size-3" />
                </button>
              )}
            </Badge>
          ))}
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={tags.length === 0 ? placeholder : ''}
            disabled={disabled}
            className="flex-1 min-w-[120px] bg-transparent border-0 outline-none placeholder:text-muted-foreground text-gray-900 dark:text-white disabled:cursor-not-allowed"
          />
        </div>
      </div>
    )
  }
)

TagInput.displayName = 'TagInput'

export { TagInput }
