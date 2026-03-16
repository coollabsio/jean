import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronRight,
  Wrench,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReviewFinding, FindingSeverity } from '@/types/chat'
import { getFindingKey } from './review-finding-utils'
import { Button } from '../ui/button'

/** Special value for custom suggestion selection */
const CUSTOM_OPTION = '__custom__'

interface ReviewFindingBlockProps {
  finding: ReviewFinding
  index: number
  findingKey: string
  isFixed: boolean
  onFix: (finding: ReviewFinding, customSuggestion?: string) => Promise<void>
  onSelectionChange?: (selection: string) => void
  disabled?: boolean
}

const severityConfig: Record<
  FindingSeverity,
  { icon: typeof AlertCircle; color: string; label: string }
> = {
  error: {
    icon: AlertCircle,
    color: 'text-red-500',
    label: 'Error',
  },
  warning: {
    icon: AlertTriangle,
    color: 'text-yellow-500',
    label: 'Warning',
  },
  info: {
    icon: Info,
    color: 'text-blue-500',
    label: 'Info',
  },
}

export function ReviewFindingBlock({
  finding,
  index,
  findingKey: _findingKey,
  isFixed,
  onFix,
  onSelectionChange,
  disabled = false,
}: ReviewFindingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(!isFixed)
  const [isFixing, setIsFixing] = useState(false)
  // Selected option: '0', '1', etc. for suggestions, or CUSTOM_OPTION for custom
  const [selectedOption, setSelectedOption] = useState<string>('0')
  const [customSuggestion, setCustomSuggestion] = useState('')

  // Notify parent of selection changes
  const handleSelectionChange = (selection: string) => {
    setSelectedOption(selection)
    onSelectionChange?.(selection)
  }

  const config = severityConfig[finding.severity]
  const Icon = config.icon

  const handleFix = async () => {
    setIsFixing(true)
    try {
      let suggestion: string | undefined
      if (selectedOption === CUSTOM_OPTION) {
        suggestion = customSuggestion.trim() || undefined
      } else {
        const idx = parseInt(selectedOption, 10)
        const selected = finding.suggestions[idx]
        suggestion = selected?.code
      }
      await onFix(finding, suggestion)
      // Collapse the finding after fixing
      setIsExpanded(false)
    } catch (error) {
      console.error('Failed to fix finding:', error)
    } finally {
      setIsFixing(false)
    }
  }

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          'my-3 rounded-lg border bg-muted/30',
          isFixed && 'opacity-60'
        )}
      >
        {/* Header */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 rounded-t-lg"
          >
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 transition-transform text-muted-foreground',
                isExpanded && 'rotate-90'
              )}
            />
            <Icon className={cn('h-4 w-4 shrink-0', config.color)} />
            <Badge
              variant="outline"
              className={cn('text-xs', config.color, 'border-current')}
            >
              {config.label}
            </Badge>
            <span className="flex-1 truncate text-sm font-medium">
              #{index + 1}: {finding.title}
            </span>
            {isFixed && (
              <Badge
                variant="outline"
                className="text-xs text-green-500 border-green-500"
              >
                Fixed
              </Badge>
            )}
            <span className="text-xs text-muted-foreground shrink-0">
              {finding.file}:{finding.line}
            </span>
          </button>
        </CollapsibleTrigger>

        {/* Content */}
        <CollapsibleContent>
          <div className="px-3 pb-3 pt-1 space-y-3">
            {/* Description */}
            {finding.description && (
              <p className="text-sm text-muted-foreground">
                {finding.description}
              </p>
            )}

            {/* Code */}
            {finding.code && (
              <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto">
                <code>{finding.code}</code>
              </pre>
            )}

            {/* Suggestions */}
            <div className="space-y-2">
              {/* Single suggestion - radio button with custom input below */}
              {!isFixed && finding.suggestions.length === 1 && (
                <>
                  <RadioGroup
                    value={selectedOption}
                    onValueChange={handleSelectionChange}
                    className="space-y-2"
                  >
                    <div
                      className={cn(
                        'rounded-md border p-2',
                        selectedOption === '0'
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-muted/30'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <RadioGroupItem value="0" id="suggestion-single-0" />
                        <Label
                          htmlFor="suggestion-single-0"
                          className="flex-1 cursor-pointer text-sm font-medium text-foreground"
                        >
                          {finding.suggestions[0]?.label}
                        </Label>
                      </div>
                      <pre className="text-xs overflow-x-auto whitespace-pre-wrap mt-1 ml-6 text-muted-foreground">
                        <code>{finding.suggestions[0]?.code}</code>
                      </pre>
                    </div>
                  </RadioGroup>
                  <Textarea
                    value={customSuggestion}
                    onChange={e => {
                      setCustomSuggestion(e.target.value)
                      if (e.target.value.trim()) {
                        handleSelectionChange(CUSTOM_OPTION)
                      } else {
                        handleSelectionChange('0')
                      }
                    }}
                    className="font-mono min-h-[60px]"
                    placeholder="Custom fix..."
                  />
                </>
              )}

              {/* Multiple suggestions - radio selection */}
              {!isFixed && finding.suggestions.length > 1 && (
                <>
                  <RadioGroup
                    value={selectedOption}
                    onValueChange={handleSelectionChange}
                    className="space-y-2"
                  >
                    {finding.suggestions.map((suggestion, idx) => (
                      <div
                        key={suggestion.label}
                        className={cn(
                          'rounded-md border p-2',
                          selectedOption === String(idx)
                            ? 'border-primary bg-primary/5'
                            : 'border-border bg-muted/30'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <RadioGroupItem
                            value={String(idx)}
                            id={`suggestion-${index}-${idx}`}
                          />
                          <Label
                            htmlFor={`suggestion-${index}-${idx}`}
                            className="flex-1 cursor-pointer text-sm font-medium text-foreground"
                          >
                            {suggestion.label}
                          </Label>
                        </div>
                        <pre className="text-xs overflow-x-auto whitespace-pre-wrap mt-1 ml-6 text-muted-foreground">
                          <code>{suggestion.code}</code>
                        </pre>
                      </div>
                    ))}
                  </RadioGroup>
                  {/* Custom fix input */}
                  <Textarea
                    value={customSuggestion}
                    onChange={e => {
                      setCustomSuggestion(e.target.value)
                      if (e.target.value.trim()) {
                        handleSelectionChange(CUSTOM_OPTION)
                      }
                    }}
                    className="font-mono min-h-[60px]"
                    placeholder="Custom fix..."
                  />
                </>
              )}

              {/* Show selected suggestion when fixed */}
              {isFixed && (
                <pre className="text-xs rounded p-2 overflow-x-auto bg-muted/50 border">
                  <code>
                    {selectedOption === CUSTOM_OPTION
                      ? customSuggestion || '(custom fix applied)'
                      : finding.suggestions[parseInt(selectedOption, 10)]
                          ?.code ||
                        finding.suggestions[0]?.code ||
                        '(fix applied)'}
                  </code>
                </pre>
              )}
            </div>

            {/* Fix Button */}
            {!isFixed && (
              <div className="flex justify-end pt-1">
                <Button onClick={handleFix} disabled={disabled || isFixing}>
                  {isFixing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Fixing...
                    </>
                  ) : (
                    <>Fix</>
                  )}
                </Button>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

interface ReviewFindingsListProps {
  findings: ReviewFinding[]
  sessionId: string
  onFix: (finding: ReviewFinding, customSuggestion?: string) => Promise<void>
  onFixAll: (
    findingsWithSuggestions: { finding: ReviewFinding; suggestion?: string }[]
  ) => Promise<void>
  isFixedFn: (findingKey: string) => boolean
  disabled?: boolean
}

/**
 * Renders a list of review findings with fix buttons
 */
export function ReviewFindingsList({
  findings,
  sessionId: _sessionId,
  onFix,
  onFixAll,
  isFixedFn,
  disabled = false,
}: ReviewFindingsListProps) {
  const [isFixingAll, setIsFixingAll] = useState(false)
  // Track selected suggestions for each finding (keyed by index)
  const [selectedSuggestions, setSelectedSuggestions] = useState<
    Record<number, string>
  >({})

  if (findings.length === 0) {
    return null
  }

  const fixedCount = findings.filter((f, i) =>
    isFixedFn(getFindingKey(f, i))
  ).length

  const unfixedCount = findings.length - fixedCount

  const handleFixAll = async () => {
    setIsFixingAll(true)
    try {
      const unfixedFindings = findings
        .map((finding, index) => ({ finding, index }))
        .filter(
          ({ finding, index }) => !isFixedFn(getFindingKey(finding, index))
        )
        .map(({ finding, index }) => {
          const selected = selectedSuggestions[index]
          let suggestion: string | undefined
          if (selected === CUSTOM_OPTION) {
            // Custom suggestions would need to be tracked separately - for now use first suggestion
            suggestion = finding.suggestions[0]?.code
          } else if (selected !== undefined) {
            const idx = parseInt(selected, 10)
            suggestion = finding.suggestions[idx]?.code
          } else {
            // Default to first suggestion
            suggestion = finding.suggestions[0]?.code
          }
          return { finding, suggestion }
        })
      await onFixAll(unfixedFindings)
    } finally {
      setIsFixingAll(false)
    }
  }

  const handleSelectionChange = (index: number, selection: string) => {
    setSelectedSuggestions(prev => ({ ...prev, [index]: selection }))
  }

  return (
    <div
      className="my-4"
      data-review-findings={unfixedCount > 0 ? 'unfixed' : 'all-fixed'}
    >
      <div className="flex items-center gap-2 mb-2">
        <AlertCircle className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {findings.length} finding{findings.length === 1 ? '' : 's'}
          {fixedCount > 0 && (
            <span className="text-green-500 ml-1">({fixedCount} fixed)</span>
          )}
        </span>
        {unfixedCount > 0 && (
          <Button
            onClick={handleFixAll}
            disabled={disabled || isFixingAll}
            className="ml-auto flex items-center"
          >
            {isFixingAll ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Fixing all...
              </>
            ) : (
              <>
                <Wrench className="h-3 w-3" />
                Fix all ({unfixedCount})
              </>
            )}
          </Button>
        )}
      </div>
      {findings.map((finding, index) => {
        const findingKey = getFindingKey(finding, index)
        return (
          <ReviewFindingBlock
            key={findingKey}
            finding={finding}
            index={index}
            findingKey={findingKey}
            isFixed={isFixedFn(findingKey)}
            onFix={onFix}
            onSelectionChange={selection =>
              handleSelectionChange(index, selection)
            }
            disabled={disabled}
          />
        )
      })}
    </div>
  )
}
