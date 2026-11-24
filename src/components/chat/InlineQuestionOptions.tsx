import { useState } from 'react'
import { Check, CircleHelp } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  inlineQuestionsAnswer,
  type InlineQuestion,
} from './inline-question-utils'

/**
 * Numbered questions that the assistant asked as text, with their options as
 * buttons. One single-choice question: a click sends "N. option" as the next
 * user message. Otherwise the user picks options and sends them with Accept.
 * Accept needs one pick; questions without a pick are skipped.
 */
export function InlineQuestionOptions({
  questions,
  disabled,
  onSend,
}: {
  questions: InlineQuestion[]
  disabled: boolean
  onSend: (text: string) => void
}) {
  const [picks, setPicks] = useState<number[][]>(() => questions.map(() => []))
  const sendOnClick = questions.length === 1 && !questions[0]?.multiple
  // Questions without a pick are sent as not answered
  const anyPick = picks.some(selected => selected.length > 0)

  const pick = (questionIndex: number, optionIndex: number) => {
    if (sendOnClick) {
      onSend(inlineQuestionsAnswer(questions, [[optionIndex]]))
      return
    }
    setPicks(current =>
      questions.map((q, i) => {
        const selected = current[i] ?? []
        if (i !== questionIndex) return selected
        // A click on a selected option clears it
        if (selected.includes(optionIndex))
          return selected.filter(index => index !== optionIndex)
        return q.multiple ? [...selected, optionIndex] : [optionIndex]
      })
    )
  }

  return (
    <section
      aria-label="Question"
      className="mt-3 flex flex-col items-start gap-2"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <CircleHelp className="size-3.5" />
        {questions.length > 1 ? 'Questions' : 'Question'}
      </div>
      {questions.map((q, questionIndex) => (
        <div
          key={`${questionIndex}-${q.question}`}
          role="group"
          aria-label={q.question}
          className="flex max-w-full flex-col items-start gap-1.5"
        >
          <p className="text-sm font-medium text-foreground">
            {q.question}
            {q.multiple && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                (pick one or more)
              </span>
            )}
          </p>
          {q.options.map((option, index) => {
            const selected = picks[questionIndex]?.includes(index) ?? false
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-pressed={sendOnClick ? undefined : selected}
                onClick={() => pick(questionIndex, index)}
                className={cn(
                  'flex max-w-full items-start gap-2.5 rounded-md bg-muted/60 px-3 py-2 text-left text-sm text-foreground ring-inset transition-colors enabled:cursor-pointer enabled:hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60',
                  selected && 'bg-primary/15 ring-1 ring-primary/60'
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded bg-background/60 text-xs font-medium tabular-nums text-muted-foreground">
                  {selected ? <Check className="size-3.5" /> : `${index + 1}.`}
                </span>
                <span className="min-w-0 flex-1">{option}</span>
              </button>
            )
          })}
        </div>
      ))}
      {!sendOnClick && (
        <Button
          size="sm"
          disabled={disabled || !anyPick}
          onClick={() => onSend(inlineQuestionsAnswer(questions, picks))}
        >
          Accept
        </Button>
      )}
    </section>
  )
}
