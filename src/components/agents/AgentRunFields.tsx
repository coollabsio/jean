import { RotateCcw } from '@/components/icons/reicon'
import { DesktopBackendModelPicker } from '@/components/chat/toolbar/DesktopBackendModelPicker'
import { ReasoningLevelDropdown } from '@/components/chat/toolbar/ReasoningLevelDropdown'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { usePreferences } from '@/services/preferences'
import { useAllBackendSkills } from '@/services/skills'
import type { CliBackend } from '@/types/preferences'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import {
  AGENT_DEFAULT_OPTION,
  backendChoices,
  effortOptionsForBackend,
  fromPickerValue,
  pickerBackend,
  skillChoices,
  thinkingOptionsForBackend,
  toggleSkill,
  toPickerValue,
  withBackend,
  withBackendModel,
  withDefaultReasoningOption,
  type AgentRunDraft,
} from './agent-config'
import { HelpTip } from './agent-ui'

interface AgentRunFieldsProps {
  value: AgentRunDraft
  onChange: (next: AgentRunDraft) => void
  idPrefix: string
  /** Server that runs the agent */
  serverId: string
  /** Label of the backend/model row */
  label?: string
  /** What "Default" falls back to, e.g. "the agent's settings" */
  inheritFrom?: string
  /** Classes for picker popovers, e.g. a z-index above a raised dialog */
  popoverClassName?: string
}

const DEFAULT_MODEL_OPTION = {
  value: AGENT_DEFAULT_OPTION,
  label: 'Default model',
}

const FORM_TRIGGER =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm dark:bg-input/30 dark:hover:bg-input/50'

/** Backend, model, reasoning, and skills for one agent or subagent type. */
export function AgentRunFields({
  value,
  onChange,
  idPrefix,
  serverId,
  label = 'Backend and model',
  inheritFrom = 'a new chat',
  popoverClassName,
}: AgentRunFieldsProps) {
  const local = serverId === LOCAL_SERVER_ID
  const { data: preferences } = usePreferences(serverId)
  const { installedBackends, isLoading } = useInstalledBackends({ serverId })
  const backends = backendChoices(installedBackends, value.backend, isLoading)
  const backendValues = backends.map(option => option.value)
  const selectedBackend = pickerBackend(
    value,
    preferences?.default_backend,
    backendValues
  )
  // Skill files are read on this machine; they do not apply to remote agents
  const skillBackend = !local
    ? []
    : value.backend
      ? [value.backend as CliBackend]
      : backendValues
  const groups = useAllBackendSkills(undefined, skillBackend)
  const skills = skillChoices(groups, value.backend)
  const efforts = effortOptionsForBackend(value.backend)
  const thinking = thinkingOptionsForBackend(value.backend)
  const inherits = !value.backend

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <Label>{label}</Label>
            <HelpTip label="About backend and model">
              {inherits
                ? `Default uses the backend and model of ${inheritFrom}. Pick one to pin it.`
                : 'Default model, effort, and thinking keep your saved choices for this backend.'}
            </HelpTip>
          </span>
          {!inherits && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => onChange(withBackend(value, ''))}
            >
              <RotateCcw />
              Use default
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DesktopBackendModelPicker
            triggerClassName={`!flex min-w-0 flex-1 basis-56 max-w-none justify-between ${FORM_TRIGGER}`}
            selectedBackend={selectedBackend}
            selectedModel={
              inherits ? AGENT_DEFAULT_OPTION : toPickerValue(value.model)
            }
            selectedProvider={null}
            installedBackends={backendValues}
            customCliProfiles={preferences?.custom_cli_profiles ?? []}
            defaultModelOption={DEFAULT_MODEL_OPTION}
            triggerLabel={
              inherits ? (
                <span className="text-foreground">
                  Default{' '}
                  <span className="text-muted-foreground">
                    · same as {inheritFrom}
                  </span>
                </span>
              ) : undefined
            }
            keyboardShortcuts={false}
            popoverClassName={popoverClassName}
            onModelChange={model =>
              onChange(withBackendModel(value, selectedBackend, model))
            }
            onBackendModelChange={(backend, model) =>
              onChange(withBackendModel(value, backend, model))
            }
          />
          {efforts.length > 0 && (
            <ReasoningLevelDropdown
              label="Effort"
              showLabel
              value={toPickerValue(value.effort)}
              options={withDefaultReasoningOption(efforts)}
              active={value.effort !== ''}
              triggerClassName={FORM_TRIGGER}
              contentClassName={popoverClassName}
              onValueChange={effort =>
                onChange({ ...value, effort: fromPickerValue(effort) })
              }
            />
          )}
          {thinking.length > 0 && (
            <ReasoningLevelDropdown
              label="Thinking"
              showLabel
              value={toPickerValue(value.thinkingLevel)}
              options={withDefaultReasoningOption(thinking)}
              active={
                value.thinkingLevel !== '' && value.thinkingLevel !== 'off'
              }
              triggerClassName={FORM_TRIGGER}
              contentClassName={popoverClassName}
              onValueChange={thinkingLevel =>
                onChange({
                  ...value,
                  thinkingLevel: fromPickerValue(thinkingLevel),
                })
              }
            />
          )}
        </div>
        {value.backend === 'cursor' && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Cursor has no Build mode, so wake-ups run in Yolo mode without
            approval prompts.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5">
          <Label>Skills</Label>
          <HelpTip label="About skills">
            Selected skills are added to the agent prompt and to each wake-up,
            the same way a skill attached in chat is. Jean lists the skills
            already installed for each backend.
          </HelpTip>
        </span>
        {!local ? (
          <p className="text-xs text-muted-foreground">
            Listed only for agents on this machine
            {value.skills.length > 0 ? ` (${value.skills.length} saved)` : ''}.
          </p>
        ) : skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">No skills installed.</p>
        ) : (
          <div className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-lg border">
            {skills.map(skill => {
              const checked = value.skills.some(
                item => item.path === skill.path
              )
              const inputId = `${idPrefix}-skill-${skill.path}`
              return (
                <label
                  key={skill.path}
                  htmlFor={inputId}
                  className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-muted/40"
                >
                  <Checkbox
                    id={inputId}
                    className="mt-0.5"
                    checked={checked}
                    onCheckedChange={next =>
                      onChange({
                        ...value,
                        skills: toggleSkill(value.skills, skill, next === true),
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{skill.name}</span>
                    {skill.description ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
