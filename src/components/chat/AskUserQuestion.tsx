import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Markdown } from '@/components/ui/markdown'
import { Kbd } from '@/components/ui/kbd'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ChevronRight, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import type { Question, QuestionAnswer } from '@/types/chat'

interface AskUserQuestionProps {
  /** Unique tool call ID */
  toolCallId: string
  /** Questions to render */
  questions: Question[]
  /** Callback when user submits answers */
  onSubmit: (toolCallId: string, answers: QuestionAnswer[]) => void
  /** Callback when user skips questions */
  onSkip?: (toolCallId: string) => void
  /** Read-only mode (for already-answered questions) */
  readOnly?: boolean
  /** Previously submitted answers (for read-only display) */
  submittedAnswers?: QuestionAnswer[]
  /** Intro text to show above questions (e.g., "Before we continue, I have some questions:") */
  introText?: string
  /** Whether a user message follows this assistant message (user responded) */
  hasFollowUpMessage?: boolean
  /** Whether the question was explicitly skipped (not answered) */
  isSkipped?: boolean
}

/**
 * Renders interactive questions from Claude's AskUserQuestion tool
 * Styled to match Claude Code CLI's question prompts
 */
export function AskUserQuestion({
  toolCallId,
  questions,
  onSubmit,
  onSkip,
  readOnly = false,
  submittedAnswers,
  introText,
  hasFollowUpMessage = false,
  isSkipped = false,
}: AskUserQuestionProps) {
  // Local state for answers
  // Structure: answers[questionIndex] = { selectedOptions: [0, 2], customText: 'foo' }
  const [answers, setAnswers] = useState<Map<number, QuestionAnswer>>(
    () => new Map()
  )
  // Collapsed state for read-only answered questions
  const [isExpanded, setIsExpanded] = useState(false)
  // Local copy of submitted answers (fallback when prop is undefined due to timing)
  const [localSubmittedAnswers, setLocalSubmittedAnswers] = useState<
    QuestionAnswer[] | null
  >(null)

  // Use prop if available, fall back to local state
  const effectiveAnswers = submittedAnswers ?? localSubmittedAnswers

  // Toggle option selection (checkbox mode)
  const toggleOption = useCallback(
    (questionIndex: number, optionIndex: number) => {
      setAnswers(prev => {
        const newAnswers = new Map(prev)
        const existing = newAnswers.get(questionIndex) || {
          questionIndex,
          selectedOptions: [],
        }

        const selectedOptions = existing.selectedOptions.includes(optionIndex)
          ? existing.selectedOptions.filter(i => i !== optionIndex)
          : [...existing.selectedOptions, optionIndex]

        newAnswers.set(questionIndex, {
          ...existing,
          selectedOptions,
          // Clear custom text when an option is selected
          customText: undefined,
        })
        return newAnswers
      })
    },
    []
  )

  // Select single option (radio mode)
  const selectOption = useCallback(
    (questionIndex: number, optionIndex: number) => {
      setAnswers(prev => {
        const newAnswers = new Map(prev)
        const existing = newAnswers.get(questionIndex) || {
          questionIndex,
          selectedOptions: [],
        }

        newAnswers.set(questionIndex, {
          ...existing,
          selectedOptions: [optionIndex],
          // Clear custom text when an option is selected
          customText: undefined,
        })
        return newAnswers
      })
    },
    []
  )

  // Update custom text
  const updateCustomText = useCallback(
    (questionIndex: number, text: string) => {
      setAnswers(prev => {
        const newAnswers = new Map(prev)
        const existing = newAnswers.get(questionIndex) || {
          questionIndex,
          selectedOptions: [],
        }

        newAnswers.set(questionIndex, {
          ...existing,
          // Clear selected options when custom text is provided
          selectedOptions: text ? [] : existing.selectedOptions,
          customText: text || undefined,
        })
        return newAnswers
      })
    },
    []
  )

  // Submit answers
  const handleSubmit = useCallback(() => {
    const answersArray = Array.from(answers.values())
    setLocalSubmittedAnswers(answersArray) // Preserve for display when transitioning to read-only
    onSubmit(toolCallId, answersArray)
  }, [toolCallId, answers, onSubmit])

  // Listen for keyboard shortcut event (CMD+Enter)
  useEffect(() => {
    if (readOnly) return

    const handleAnswerQuestion = () => {
      handleSubmit()
    }

    window.addEventListener('answer-question', handleAnswerQuestion)
    return () =>
      window.removeEventListener('answer-question', handleAnswerQuestion)
  }, [readOnly, handleSubmit])

  // Generate summary text for collapsed view
  const getAnswerSummary = useCallback(() => {
    // No answer data available (e.g., Zustand state lost after reload)
    if (!effectiveAnswers || effectiveAnswers.length === 0) {
      // Explicit skip always shows "Skipped"
      if (isSkipped) return 'Skipped'
      // If a follow-up user message exists, the user DID respond — show "Answered"
      // (specific answer text is unavailable since Zustand state is ephemeral)
      if (hasFollowUpMessage) return 'Answered'
      return 'Skipped'
    }

    const summaryParts: string[] = []
    for (const answer of effectiveAnswers) {
      const question = questions[answer.questionIndex]
      if (!question) continue

      // Custom text takes precedence
      if (answer.customText) {
        summaryParts.push(`"${answer.customText}"`)
      } else if (answer.selectedOptions.length > 0) {
        const selectedLabels = answer.selectedOptions
          .map(idx => question.options[idx]?.label)
          .filter(Boolean)
        summaryParts.push(selectedLabels.join(', '))
      }
    }

    return summaryParts.length > 0 ? summaryParts.join(' | ') : 'Answered'
  }, [effectiveAnswers, questions, isSkipped, hasFollowUpMessage])

  // Render collapsed summary for answered questions
  // Note: Show collapsed view when readOnly=true even if effectiveAnswers is undefined
  // (can happen on reload before state is restored). getAnswerSummary() handles this case.
  if (readOnly) {
    return (
      <Collapsible
        open={isExpanded}
        onOpenChange={setIsExpanded}
        className="min-w-0"
      >
        <div className="my-2 min-w-0 rounded border border-muted bg-muted/30 font-mono text-sm">
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
            <span className="truncate font-medium">{getAnswerSummary()}</span>
            <ChevronRight
              className={cn(
                'ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isExpanded && 'rotate-90'
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-muted px-4 py-3">
              {renderQuestionContent()}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    )
  }

  // Render full question content (used both inline and in collapsible)
  function renderQuestionContent() {
    return (
      <div className="space-y-6">
        {/* Intro text (e.g., "Before we continue, I have some questions:") */}
        {introText && (
          <div className="text-muted-foreground">
            <Markdown>{introText}</Markdown>
          </div>
        )}
        {questions.map((question, qIndex) => {
          const answer = readOnly
            ? effectiveAnswers?.find(a => a.questionIndex === qIndex)
            : answers.get(qIndex)

          return (
            <div key={qIndex}>
              {/* Header (optional) */}
              {question.header && (
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {question.header}
                </div>
              )}

              {/* Question text */}
              <div className="mb-3 font-medium text-foreground">
                <Markdown>{question.question}</Markdown>
              </div>

              {/* Options - indented section */}
              <div className="ml-3 space-y-3">
                {question.multiSelect ? (
                  // Checkbox mode
                  <div className="space-y-2.5">
                    {question.options.map((option, oIndex) => (
                      <div key={oIndex} className="flex items-start gap-2.5">
                        <Checkbox
                          id={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          checked={
                            answer?.selectedOptions.includes(oIndex) ?? false
                          }
                          onCheckedChange={() =>
                            !readOnly && toggleOption(qIndex, oIndex)
                          }
                          disabled={readOnly}
                          className={cn(
                            'mt-0.5',
                            !readOnly && 'cursor-pointer'
                          )}
                        />
                        <Label
                          htmlFor={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          className={cn(
                            'flex flex-1 flex-col items-start',
                            !readOnly && 'cursor-pointer'
                          )}
                        >
                          <span className="font-medium">
                            <Markdown>{option.label}</Markdown>
                          </span>
                          {option.description && (
                            <span className="mt-1 text-xs text-muted-foreground">
                              <Markdown>{option.description}</Markdown>
                            </span>
                          )}
                        </Label>
                      </div>
                    ))}
                  </div>
                ) : (
                  // Radio mode
                  <RadioGroup
                    value={answer?.selectedOptions[0]?.toString() ?? ''}
                    onValueChange={value =>
                      !readOnly && selectOption(qIndex, parseInt(value, 10))
                    }
                    disabled={readOnly}
                    className="space-y-2.5"
                  >
                    {question.options.map((option, oIndex) => (
                      <div key={oIndex} className="flex items-start gap-2.5">
                        <RadioGroupItem
                          value={oIndex.toString()}
                          id={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          className={cn(
                            'mt-0.5',
                            !readOnly && 'cursor-pointer'
                          )}
                        />
                        <Label
                          htmlFor={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          className={cn(
                            'flex flex-1 flex-col items-start',
                            !readOnly && 'cursor-pointer'
                          )}
                        >
                          <span className="font-medium">
                            <Markdown>{option.label}</Markdown>
                          </span>
                          {option.description && (
                            <span className="mt-1 text-xs text-muted-foreground">
                              <Markdown>{option.description}</Markdown>
                            </span>
                          )}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}

                {/* Show custom text if provided (read-only) or input field (editable) */}
                {readOnly ? (
                  answer?.customText && (
                    <div className="pt-1 text-muted-foreground italic">
                      &ldquo;{answer.customText}&rdquo;
                    </div>
                  )
                ) : (
                  <div className="pt-1">
                    <Input
                      placeholder="Or type your own answer..."
                      value={answers.get(qIndex)?.customText ?? ''}
                      onChange={e => updateCustomText(qIndex, e.target.value)}
                      disabled={readOnly}
                      className="cursor-text font-mono text-sm select-text bg-white dark:bg-input"
                    />
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {/* Submit/Skip buttons (only if not read-only) */}
        {!readOnly && (
          <div className="flex justify-start gap-2 pt-2">
            <Button size="sm" onClick={handleSubmit}>
              Answer
              <Kbd className="ml-1.5 h-4 text-[10px] bg-primary-foreground/20 text-primary-foreground">
                {formatShortcutDisplay(
                  DEFAULT_KEYBINDINGS.approve_plan ?? 'mod+enter'
                )}
              </Kbd>
            </Button>
            {onSkip && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSkip(toolCallId)}
                className="text-muted-foreground"
              >
                Skip
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  // Default: render full interactive question form
  return (
    <div className="my-3 min-w-0 cursor-default rounded border border-primary/30 bg-primary/5 p-4 font-mono text-sm select-none">
      {renderQuestionContent()}
    </div>
  )
}
