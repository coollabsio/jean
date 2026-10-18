import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useAllBackendSkills } from '@/services/skills'
import type { CliBackend } from '@/types/preferences'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import {
  backendChoices,
  effortOptionsForBackend,
  modelOptionsForBackend,
  skillChoices,
  thinkingOptionsForBackend,
  toggleSkill,
  withBackend,
  type AgentRunDraft,
} from './agent-config'

interface AgentRunFieldsProps {
  value: AgentRunDraft
  onChange: (next: AgentRunDraft) => void
  idPrefix: string
  /** Server that runs the agent */
  serverId: string
}

function SelectField({
  id,
  label,
  hint,
  value,
  disabled,
  options,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  disabled?: boolean
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1.5 [&_[data-slot=native-select-wrapper]]:w-full">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      >
        <NativeSelectOption value="">Default</NativeSelectOption>
        {options.map(option => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

/** Backend, model, reasoning, and skills for one agent. */
export function AgentRunFields({
  value,
  onChange,
  idPrefix,
  serverId,
}: AgentRunFieldsProps) {
  // Installed backends and skill files are read on this machine. They do not
  // apply to an agent that runs on a remote server.
  const local = serverId === LOCAL_SERVER_ID
  const { installedBackends, isLoading } = useInstalledBackends()
  const backends = backendChoices(
    local ? installedBackends : [],
    value.backend,
    isLoading
  )
  const skillBackend = !local
    ? []
    : value.backend
      ? [value.backend as CliBackend]
      : backends.map(option => option.value)
  const groups = useAllBackendSkills(undefined, skillBackend)
  const skills = skillChoices(groups, value.backend)
  const models = modelOptionsForBackend(value.backend)
  const efforts = effortOptionsForBackend(value.backend)
  const thinking = thinkingOptionsForBackend(value.backend)

  return (
    <div className="space-y-4">
      <SelectField
        id={`${idPrefix}-backend`}
        label="Backend"
        hint={
          value.backend === 'cursor'
            ? 'Cursor has no Build mode, so wake-ups run in Yolo mode without approval prompts.'
            : 'Default uses the same backend as a new chat.'
        }
        value={value.backend}
        options={backends}
        onChange={backend => onChange(withBackend(value, backend))}
      />
      <SelectField
        id={`${idPrefix}-model`}
        label="Model"
        hint={
          value.backend
            ? 'Default uses your saved model for this backend.'
            : 'Choose a backend to pick a model.'
        }
        value={
          models.some(option => option.value === value.model) ? value.model : ''
        }
        disabled={!value.backend}
        options={models}
        onChange={model => onChange({ ...value, model })}
      />
      {efforts.length > 0 && (
        <SelectField
          id={`${idPrefix}-effort`}
          label="Effort"
          hint="Default leaves effort unset, the same as a new chat."
          value={
            efforts.some(option => option.value === value.effort)
              ? value.effort
              : ''
          }
          options={efforts}
          onChange={effort => onChange({ ...value, effort })}
        />
      )}
      {thinking.length > 0 && (
        <SelectField
          id={`${idPrefix}-thinking`}
          label="Thinking"
          hint="Default leaves thinking unset."
          value={
            thinking.some(option => option.value === value.thinkingLevel)
              ? value.thinkingLevel
              : ''
          }
          options={thinking}
          onChange={thinkingLevel => onChange({ ...value, thinkingLevel })}
        />
      )}
      <div className="space-y-1.5">
        <Label>Skills</Label>
        {!local ? (
          <p className="text-xs text-muted-foreground">
            Skills are listed only for agents on this machine.
            {value.skills.length > 0
              ? ` ${value.skills.length} saved skill${value.skills.length === 1 ? '' : 's'} stay selected.`
              : ''}
          </p>
        ) : skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No skills discovered
            {value.backend ? ' for this backend' : ''}. Jean lists the skills
            already installed for each backend.
          </p>
        ) : (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
            {skills.map(skill => {
              const checked = value.skills.some(
                item => item.path === skill.path
              )
              const inputId = `${idPrefix}-skill-${skill.path}`
              return (
                <label
                  key={skill.path}
                  htmlFor={inputId}
                  className="flex cursor-pointer items-start gap-2 rounded-sm px-1 py-1 hover:bg-muted/60"
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
        <p className="text-xs text-muted-foreground">
          Selected skills are added to the agent prompt and to each wake-up, the
          same way a skill attached in chat is.
        </p>
      </div>
    </div>
  )
}
