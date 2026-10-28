import { GitBranch, Rabbit, type LucideIcon } from '@/components/icons/reicon'
import { BackendLabel, getBackendIcon } from '@/components/ui/backend-label'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useSettingsTargetServerId } from '@/lib/settings-target'
import { cn } from '@/lib/utils'
import type { PreferencePane } from '@/store/ui-store'
import type { CliBackend } from '@/types/preferences'
import { GeneralPane } from './GeneralPane'
import { AntigravityPane } from './AntigravityPane'
import { MusePane } from './MusePane'
import {
  ClaudeProvidersSection,
  CodexProvidersSection,
  PiProvidersSection,
} from './BackendProviders'

const CLI_BACKEND_PANES = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'pi',
  'commandcode',
  'grok',
  'kimi',
  'devin',
  'antigravity',
  'muse',
] as const satisfies readonly (CliBackend & PreferencePane)[]

const TOOL_PANES = [
  { id: 'github', name: 'Git Provider', icon: GitBranch },
  { id: 'coderabbit', name: 'CodeRabbit CLI', icon: Rabbit },
] as const satisfies readonly {
  id: PreferencePane
  name: string
  icon: LucideIcon
}[]

export type BackendPane =
  | (typeof CLI_BACKEND_PANES)[number]
  | (typeof TOOL_PANES)[number]['id']

const BACKEND_PANES: readonly PreferencePane[] = [
  ...CLI_BACKEND_PANES,
  ...TOOL_PANES.map(tool => tool.id),
]

export function isBackendPane(pane: PreferencePane): pane is BackendPane {
  return BACKEND_PANES.includes(pane)
}

function BackendContent({ backend }: { backend: BackendPane }) {
  switch (backend) {
    case 'antigravity':
      return <AntigravityPane />
    case 'muse':
      return <MusePane />
    case 'claude':
      return (
        <>
          <GeneralPane scope="claude" />
          <ClaudeProvidersSection />
        </>
      )
    case 'codex':
      return (
        <>
          <GeneralPane scope="codex" />
          <CodexProvidersSection />
        </>
      )
    case 'pi':
      return (
        <>
          <GeneralPane scope="pi" />
          <PiProvidersSection />
        </>
      )
    default:
      return <GeneralPane scope={backend} />
  }
}

function BackendTab({
  selected,
  muted,
  onSelect,
  children,
}: {
  selected: boolean
  muted: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors [&_svg]:size-4',
        selected
          ? 'bg-muted font-medium text-foreground'
          : muted
            ? 'text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground'
            : 'text-foreground hover:bg-muted/60'
      )}
    >
      {children}
    </button>
  )
}

/** One Settings pane for every AI backend and Git tool, switched by a tab strip. */
export function BackendsPane({
  backend,
  onBackendChange,
}: {
  backend: BackendPane
  onBackendChange: (backend: BackendPane) => void
}) {
  const serverId = useSettingsTargetServerId()
  const { installedBackends } = useInstalledBackends({ serverId })
  const installed = new Set<CliBackend>(installedBackends)
  const orderedBackends = [
    ...CLI_BACKEND_PANES.filter(id => installed.has(id)),
    ...CLI_BACKEND_PANES.filter(id => !installed.has(id)),
  ]

  return (
    <div className="space-y-8">
      <div
        role="tablist"
        aria-label="Backends"
        className="flex flex-wrap gap-1 border-b border-border pb-3"
      >
        {orderedBackends.map(id => {
          const Icon = getBackendIcon(id)
          return (
            <BackendTab
              key={id}
              selected={backend === id}
              muted={!installed.has(id)}
              onSelect={() => onBackendChange(id)}
            >
              <Icon aria-hidden="true" />
              <BackendLabel backend={id} />
            </BackendTab>
          )
        })}
        {TOOL_PANES.map(tool => (
          <BackendTab
            key={tool.id}
            selected={backend === tool.id}
            muted={false}
            onSelect={() => onBackendChange(tool.id)}
          >
            <tool.icon aria-hidden="true" />
            {tool.name}
          </BackendTab>
        ))}
      </div>
      <div id={`pref-pane-${backend}`} role="tabpanel" className="space-y-8">
        <BackendContent backend={backend} />
      </div>
    </div>
  )
}
