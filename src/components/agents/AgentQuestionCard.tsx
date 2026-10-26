import { useState, type ReactNode } from 'react'
import { Check } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  questionAnswerText,
  selectedOptions,
  type AgentQuestion,
} from './agent-messages'

/**
 * Question in the agent chat (`ask_user`, approvals). One answer: a click
 * sends it. Multiple answers: pick options, then Send. Read-only once answered.
 */
export function AgentQuestionCard({
  question,
  answer,
  disabled,
  onSend,
  children,
}: {
  question: AgentQuestion
  /** The answer, if the user already gave one */
  answer: string | undefined
  disabled: boolean
  onSend: ((text: string) => void) | undefined
  /** Extra line below the options (for example, a result) */
  children?: ReactNode
}) {
  const [picked, setPicked] = useState<string[]>([])
  const answered = answer !== undefined
  const chosen = answered ? selectedOptions(question, answer) : picked
  const locked = answered || disabled || !onSend

  const choose = (option: string) => {
    if (!question.multiple) {
      onSend?.(questionAnswerText(question, [option]))
      return
    }
    setPicked(current =>
      current.includes(option)
        ? current.filter(o => o !== option)
        : [...current, option]
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-2 rounded-lg border bg-background p-3">
      <p className="text-sm font-medium text-foreground">{question.question}</p>
      {question.multiple && !answered && (
        <p className="text-xs text-muted-foreground">Select one or more.</p>
      )}
      <div className="flex flex-col gap-1.5">
        {question.options.map(option => {
          const isChosen = chosen.includes(option)
          return (
            <button
              key={option}
              type="button"
              disabled={locked}
              aria-pressed={question.multiple ? isChosen : undefined}
              onClick={() => choose(option)}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition-colors',
                'enabled:hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default',
                isChosen
                  ? 'border-primary/60 bg-primary/10 text-foreground'
                  : 'text-foreground',
                answered && !isChosen && 'text-muted-foreground opacity-60'
              )}
            >
              {question.multiple && (
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded border',
                    isChosen &&
                      'border-primary bg-primary text-primary-foreground'
                  )}
                >
                  {isChosen && <Check className="size-3" />}
                </span>
              )}
              <span className="min-w-0 flex-1">{option}</span>
              {!question.multiple && answered && isChosen && (
                <Check className="size-4 shrink-0 text-primary" />
              )}
            </button>
          )
        })}
      </div>
      {question.multiple && !answered && (
        <Button
          size="sm"
          className="self-end"
          disabled={locked || picked.length === 0}
          onClick={() => onSend?.(questionAnswerText(question, picked))}
        >
          Send
        </Button>
      )}
      {answered && chosen.length === 0 && (
        <p className="text-xs text-muted-foreground">Answered in the chat.</p>
      )}
      {children}
    </div>
  )
}
