import {
  useState,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
} from 'react'
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
import { ChevronRight, CheckCircle2, Circle } from 'lucide-react'
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
  /** Persisted tool output (fallback when Zustand state is lost after reload) */
  toolOutput?: string
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
  toolOutput,
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

  // Reconstruct QuestionAnswer[] from toolOutput by trying JSON parse first,
  // then matching option labels against the raw output string
  const answersFromOutput = useMemo(() => {
    if (!toolOutput) return null

    // Try JSON parse first (our custom format stored at answer time)
    try {
      const parsed = JSON.parse(toolOutput)
      if (
        Array.isArray(parsed) &&
        parsed.every(a => 'questionIndex' in a && 'selectedOptions' in a)
      ) {
        return parsed as QuestionAnswer[]
      }
    } catch {
      // Not JSON — try matching raw output against option labels
    }

    // Match raw tool output against option labels
    const answers: QuestionAnswer[] = []
    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
      const question = questions[qIndex]
      if (!question) continue
      const selectedOptions: number[] = []
      for (let oIndex = 0; oIndex < question.options.length; oIndex++) {
        const label = question.options[oIndex]?.label
        if (label && toolOutput.includes(label)) {
          selectedOptions.push(oIndex)
        }
      }
      if (selectedOptions.length > 0) {
        answers.push({ questionIndex: qIndex, selectedOptions })
      }
    }
    return answers.length > 0 ? answers : null
  }, [toolOutput, questions])

  // Use prop if available, fall back to local state, then to reconstructed from output
  const effectiveAnswers =
    submittedAnswers ?? localSubmittedAnswers ?? answersFromOutput

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
  const onAnswerQuestion = useEffectEvent(() => {
    handleSubmit()
  })

  useEffect(() => {
    if (readOnly) return

    const handleAnswerQuestion = () => {
      onAnswerQuestion()
    }

    window.addEventListener('answer-question', handleAnswerQuestion)
    return () =>
      window.removeEventListener('answer-question', handleAnswerQuestion)
  }, [readOnly])

  // Generate summary text for collapsed view
  const getAnswerSummary = useCallback(() => {
    // No answer data available (e.g., Zustand state lost after reload)
    if (!effectiveAnswers || effectiveAnswers.length === 0) {
      // Explicit skip always shows "Skipped"
      if (isSkipped) return 'Skipped'
      // If a follow-up user message exists, the user DID respond — show "Answered"
      // but details are unavailable.
      if (hasFollowUpMessage) return 'Answered (details unavailable)'
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
        const selectedLabels = answer.selectedOptions.flatMap(idx => {
          const label = question.options[idx]?.label
          return label ? [label] : []
        })
        summaryParts.push(selectedLabels.join(', '))
      }
    }

    return summaryParts.length > 0
      ? summaryParts.join(' | ')
      : 'Answered (details unavailable)'
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
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50">
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
          const allowsCustomText = question.isOther ?? true
          const selectedOptionsSet = new Set(answer?.selectedOptions)

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
                {readOnly ? (
                  <div className="space-y-2.5">
                    {question.options.map((option, oIndex) => {
                      const isSelected = selectedOptionsSet.has(oIndex)
                      return (
                        <div
                          key={oIndex}
                          className={cn(
                            'flex items-start gap-2.5 rounded-md border px-2.5 py-2',
                            isSelected
                              ? 'border-green-500/40 bg-green-500/10 text-foreground'
                              : 'border-transparent bg-muted/25 text-muted-foreground'
                          )}
                        >
                          {isSelected ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                          ) : (
                            <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />
                          )}
                          <div className="flex flex-1 flex-col items-start">
                            <span
                              className={cn(
                                'font-medium',
                                !isSelected && 'text-muted-foreground'
                              )}
                            >
                              <Markdown>{option.label}</Markdown>
                            </span>
                            {option.description && (
                              <span className="mt-1 text-xs text-muted-foreground">
                                <Markdown>{option.description}</Markdown>
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : question.multiSelect ? (
                  <div className="space-y-2.5">
                    {question.options.map((option, oIndex) => (
                      <div
                        key={oIndex}
                        className={cn(
                          'flex items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors',
                          selectedOptionsSet.has(oIndex)
                            ? 'border-green-500/40 bg-green-500/10'
                            : 'border-transparent bg-muted/25 hover:bg-muted/40'
                        )}
                      >
                        <Checkbox
                          id={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          checked={selectedOptionsSet.has(oIndex)}
                          onCheckedChange={() => toggleOption(qIndex, oIndex)}
                          className="mt-0.5 cursor-pointer"
                        />
                        <Label
                          htmlFor={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          className="flex flex-1 cursor-pointer flex-col items-start"
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
                  <RadioGroup
                    value={answer?.selectedOptions[0]?.toString() ?? ''}
                    onValueChange={value =>
                      selectOption(qIndex, parseInt(value, 10))
                    }
                    className="space-y-2.5"
                  >
                    {question.options.map((option, oIndex) => (
                      <div
                        key={oIndex}
                        className={cn(
                          'flex items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors',
                          selectedOptionsSet.has(oIndex)
                            ? 'border-green-500/40 bg-green-500/10'
                            : 'border-transparent bg-muted/25 hover:bg-muted/40'
                        )}
                      >
                        <RadioGroupItem
                          value={oIndex.toString()}
                          id={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          className="mt-0.5 cursor-pointer"
                        />
                        <Label
                          htmlFor={`${toolCallId}-q${qIndex}-o${oIndex}`}
                          className="flex flex-1 cursor-pointer flex-col items-start"
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
                  answer?.customText ? (
                    <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-foreground">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">
                        Custom Answer
                      </div>
                      <div className="italic">
                        &ldquo;{answer.customText}&rdquo;
                      </div>
                    </div>
                  ) : !answer ? (
                    <div className="pt-1 text-sm text-muted-foreground italic">
                      Answer details unavailable after reload.
                    </div>
                  ) : null
                ) : allowsCustomText ? (
                  <div className="pt-1">
                    <Input
                      placeholder="Or type your own answer..."
                      type={question.isSecret ? 'password' : 'text'}
                      value={answers.get(qIndex)?.customText ?? ''}
                      onChange={e => updateCustomText(qIndex, e.target.value)}
                      disabled={readOnly}
                      className="cursor-text font-mono text-base select-text bg-white dark:bg-input md:text-sm"
                    />
                  </div>
                ) : null}
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
    <div className="my-3 min-w-0 cursor-default rounded border border-muted bg-muted/30 p-4 font-mono text-sm select-none">
      {renderQuestionContent()}
    </div>
  )
}
