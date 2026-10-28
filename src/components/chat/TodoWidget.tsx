import { useState } from 'react'
import {
  CheckCircle2,
  Circle,
  Loader2,
  ListTodo,
  XCircle,
  X,
} from '@/components/icons/reicon'
import type { Todo } from '@/types/chat'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

interface TodoWidgetProps {
  todos: Todo[]
  className?: string
  /** Whether the prompt execution is still in progress */
  isStreaming?: boolean
  /** Callback to dismiss the widget */
  onClose?: () => void
  /** Whether to start expanded (default: false) */
  defaultOpen?: boolean
}

/**
 * Collapsible widget displaying the current todo list from TodoWrite tool calls
 * Shows task progress with status icons and count summary
 * Auto-collapses when all tasks are completed and execution is done
 */
export function TodoWidget({
  todos,
  className,
  isStreaming = false,
  onClose,
  defaultOpen = false,
}: TodoWidgetProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const completedCount = todos.filter(t => t.status === 'completed').length
  const totalCount = todos.length
  const allCompleted = completedCount === totalCount && totalCount > 0

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-left select-none hover:bg-muted/50">
            {!isOpen &&
            !allCompleted &&
            (isStreaming || todos.some(t => t.status === 'in_progress')) ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            ) : (
              <ListTodo className="size-4 shrink-0" />
            )}
            <span className="font-medium">Tasks</span>
            <Badge variant={allCompleted ? 'success' : 'subtle'}>
              {completedCount}/{totalCount}
            </Badge>
          </CollapsibleTrigger>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="mx-2 rounded p-0.5 transition-colors hover:bg-muted"
              aria-label="Dismiss tasks"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <CollapsibleContent>
          <div className="max-h-[50vh] overflow-y-auto px-3 pb-2">
            <ul className="space-y-1">
              {todos.map(todo => (
                <TodoItem key={todo.content} todo={todo} />
              ))}
            </ul>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface TodoItemProps {
  todo: Todo
}

function TodoItem({ todo }: TodoItemProps) {
  return (
    <li className="flex items-start gap-2 py-0.5 text-xs">
      <span className="mt-0.5 shrink-0">
        {todo.status === 'completed' ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : todo.status === 'cancelled' ? (
          <XCircle className="h-4 w-4 text-warning" />
        ) : todo.status === 'in_progress' ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground/50" />
        )}
      </span>
      <span
        className={cn(
          'text-muted-foreground',
          todo.status === 'completed' &&
            'line-through text-muted-foreground/60',
          todo.status === 'cancelled' && 'text-muted-foreground/60'
        )}
      >
        {todo.status === 'in_progress' ? todo.activeForm : todo.content}
      </span>
    </li>
  )
}
