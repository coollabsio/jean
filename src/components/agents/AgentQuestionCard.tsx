import { useCallback, useMemo } from 'react'
import { AskUserQuestion } from '@/components/chat/AskUserQuestion'
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

  const submittedAnswers = useMemo<QuestionAnswer[] | undefined>(() => {
    if (answer === undefined) return undefined
    const picked = selectedOptions(question, answer)
    if (picked.length === 0)
      return [{ questionIndex: 0, selectedOptions: [], customText: answer }]
    return [
      {
        questionIndex: 0,
        selectedOptions: picked.map(o => question.options.indexOf(o)),
      },
    ]
  }, [question, answer])

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

  return (
    <AskUserQuestion
      toolCallId={id}
      questions={questions}
      onSubmit={handleSubmit}
      readOnly={answer !== undefined}
      submittedAnswers={submittedAnswers}
      hasFollowUpMessage={answer !== undefined}
      submitDisabled={disabled || !onSend}
      submitOnSelect
    />
  )
}
