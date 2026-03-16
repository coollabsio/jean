import { useState } from 'react'
import {
  CheckCircle2,
  Circle,
  Loader2,
  ChevronRight,
  ListTodo,
  XCircle,
  X,
} from 'lucide-react'
import type { Todo } from '@/types/chat'
import { cn } from '@/lib/utils'
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
      <div
        className={cn(
          'mt-1 rounded-md border border-border bg-sidebar',
          isOpen && 'bg-sidebar'
        )}
      >
        <div className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex flex-1 items-center gap-2 hover:bg-muted/50 cursor-pointer select-none -ml-3 -my-2 pl-3 py-2 rounded-l-md">
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
            {!isOpen &&
            !allCompleted &&
            (isStreaming || todos.some(t => t.status === 'in_progress')) ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : (
              <ListTodo className="h-4 w-4 shrink-0" />
            )}
            <span className="font-medium">Tasks</span>
            <span
              className={cn(
                'rounded bg-muted/50 px-1.5 py-0.5 text-xs',
                allCompleted &&
                  'bg-green-500/20 text-green-600 dark:text-green-400'
              )}
            >
              {completedCount}/{totalCount}
            </span>
          </CollapsibleTrigger>
          {/* Close button */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-0.5 rounded hover:bg-muted transition-colors"
              aria-label="Dismiss tasks"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <CollapsibleContent>
          <div className="border-t border-border/50 px-3 py-2">
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
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : todo.status === 'cancelled' ? (
          <XCircle className="h-4 w-4 text-amber-500" />
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
