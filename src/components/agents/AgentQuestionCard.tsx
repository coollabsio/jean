import { useCallback, useMemo } from 'react'
import { User } from '@/components/icons/reicon'
import { AskUserQuestion } from '@/components/chat/AskUserQuestion'
import { ReplyBubble } from '@/components/chat/ReplyBubble'
import type { Question, QuestionAnswer } from '@/types/chat'
import {
  questionAnswerText,
  selectedOptions,
  type AgentQuestion,
} from './agent-messages'

/**
 * Question in the agent chat (`ask_user`, approvals), shown with the project
 * session question card. One answer: a click sends it. Multiple answers: pick
 * options, then Answer. The answer goes to the chat as a user message.
 * Once answered, it shows as a reply bubble with the question and the answer.
 */
export function AgentQuestionCard({
  id,
  question,
  answer,
  disabled,
  onSend,
}: {
  id: string
  question: AgentQuestion
  /** The answer, if the user already gave one */
  answer: string | undefined
  disabled: boolean
  onSend: ((text: string) => void) | undefined
}) {
  const questions = useMemo<Question[]>(
    () => [
      {
        question: question.question,
        multiSelect: question.multiple,
        options: question.options.map(label => ({ label })),
        isOther: false,
      },
    ],
    [question]
  )

  const handleSubmit = useCallback(
    (_toolCallId: string, answers: QuestionAnswer[]) => {
      const picked = (answers[0]?.selectedOptions ?? []).flatMap(index => {
        const option = question.options[index]
        return option ? [option] : []
      })
      if (picked.length > 0) onSend?.(questionAnswerText(question, picked))
    },
    [question, onSend]
  )

  if (answer !== undefined) {
    const picked = selectedOptions(question, answer)
    return (
      <ReplyBubble>
        <div className="flex flex-col gap-2 text-muted-foreground">
          <p className="whitespace-pre-wrap">{question.question}</p>
          <div className="flex items-start gap-2">
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background"
              aria-label="Your answer"
            >
              <User className="size-3" aria-hidden />
            </span>
            <span className="min-w-0 whitespace-pre-wrap">
              {picked.length > 0 ? picked.join(', ') : answer.trim()}
            </span>
          </div>
        </div>
      </ReplyBubble>
    )
  }

  return (
    <AskUserQuestion
      toolCallId={id}
      questions={questions}
      onSubmit={handleSubmit}
      submitDisabled={disabled || !onSend}
      submitOnSelect
    />
  )
}
