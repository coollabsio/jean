/**
 * Normalizes every CLI's service hooks (status, auth, PATH detection, install)
 * into one `CliFlow` shape so onboarding can treat all CLIs the same way.
 *
 * All hooks follow the SettingsTargetProvider context, so on a remote target
 * the flows install and authenticate on that server.
 */

import { loginArgsForBackend } from '@/lib/cli-auth'
import { getBackendLabel } from '@/components/ui/backend-label'
import {
  useClaudeCliAuth,
  useClaudeCliSetup,
  useClaudePathDetection,
} from '@/services/claude-cli'
import {
  useCodexCliAuth,
  useCodexCliSetup,
  useCodexPathDetection,
} from '@/services/codex-cli'
import {
  useOpenCodeCliAuth,
  useOpenCodeCliSetup,
  useOpenCodePathDetection,
} from '@/services/opencode-cli'
import {
  useCursorCliAuth,
  useCursorCliStatus,
  useCursorPathDetection,
} from '@/services/cursor-cli'
import {
  usePiCliAuth,
  usePiCliSetup,
  usePiPathDetection,
} from '@/services/pi-cli'
import {
  useCommandCodeCliAuth,
  useCommandCodeCliSetup,
  useCommandCodePathDetection,
} from '@/services/commandcode-cli'
import {
  useGrokCliAuth,
  useGrokCliSetup,
  useGrokPathDetection,
} from '@/services/grok-cli'
import {
  useKimiCliAuth,
  useKimiCliSetup,
  useKimiPathDetection,
} from '@/services/kimi-cli'
import {
  useAntigravityCliAuth,
  useAntigravityCliSetup,
  useAntigravityPathDetection,
} from '@/services/antigravity-cli'
import {
  useMuseCliAuth,
  useMuseCliSetup,
  useMusePathDetection,
} from '@/services/muse-cli'
import {
  useDevinCliAuth,
  useDevinCliSetup,
  useDevinPathDetection,
} from '@/services/devin-cli'
import {
  useGhCliAuth,
  useGhCliSetup,
  useGhPathDetection,
} from '@/services/gh-cli'
import {
  useGlabCliAuth,
  useGlabCliSetup,
  useGlabPathDetection,
} from '@/services/glab-cli'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'

export type AIBackend =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'pi'
  | 'commandcode'
  | 'grok'
  | 'kimi'
  | 'antigravity'
  | 'muse'
  | 'devin'
export type CliType = AIBackend | 'gh' | 'glab'

export const AI_BACKENDS: AIBackend[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'pi',
  'commandcode',
  'grok',
  'kimi',
  'antigravity',
  'muse',
  'devin',
]

export interface CliProgress {
  stage: string
  message: string
  percent: number
}

/** Fresh status after a refetch (avoids reading stale render values). */
export interface CliCheck {
  installed: boolean
  authenticated: boolean
}

export interface CliFlow {
  cli: CliType
  label: string
  installed: boolean
  authenticated: boolean
  ready: boolean
  statusLoading: boolean
  authLoading: boolean
  pathFound: boolean
  pathPath: string | null
  /** Preference `${cli}_cli_source`; null for Cursor (always PATH). */
  source: 'jean' | 'path' | null
  /** Cursor installs through its official installer in a terminal. */
  installMode: 'managed' | 'terminal'
  /** Managed: installs the latest stable version as a Jean-managed CLI. */
  install: () => Promise<CliCheck>
  isInstalling: boolean
  installError: unknown
  progress: CliProgress | null
  /** Switches the CLI source to the binary found on PATH. */
  usePath: () => Promise<CliCheck>
  refetch: () => Promise<CliCheck>
  loginCommand: string
  loginArgs: string[]
}

export function cliLabel(cli: CliType): string {
  if (cli === 'gh') return 'GitHub CLI'
  if (cli === 'glab') return 'GitLab CLI'
  return getBackendLabel(cli)
}

// ---------------------------------------------------------------------------
// Structural shapes shared by every service hook
// ---------------------------------------------------------------------------

interface VersionLike {
  version: string
  prerelease?: boolean
}

interface StatusLike {
  installed: boolean
  path?: string | null
  supports_auth_command?: boolean
}

interface ManagedSetup {
  status: StatusLike | undefined
  isStatusLoading: boolean
  versions: VersionLike[]
  refetchVersions: () => Promise<{ data?: VersionLike[] } | undefined>
  isInstalling: boolean
  installError: unknown
  progress: CliProgress | null
  install: (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => void
  refetchStatus: () => Promise<{ data?: StatusLike } | undefined>
}

interface AuthQuery {
  data?: { authenticated: boolean; timedOut?: boolean }
  isLoading: boolean
  isFetching: boolean
  refetch: () => Promise<
    { data?: { authenticated: boolean; timedOut?: boolean } } | undefined
  >
}

interface PathQuery {
  data?: { found: boolean; path: string | null }
  isLoading?: boolean
}

interface StatusQuery {
  data?: StatusLike
  isLoading: boolean
  refetch: () => Promise<{ data?: StatusLike } | undefined>
}

type SourceKey = Extract<keyof AppPreferences, `${string}_cli_source`>
type PatchPreferences = (patch: Partial<AppPreferences>) => Promise<unknown>

const SOURCE_KEYS: Record<Exclude<CliType, 'cursor'>, SourceKey> = {
  claude: 'claude_cli_source',
  codex: 'codex_cli_source',
  opencode: 'opencode_cli_source',
  pi: 'pi_cli_source',
  commandcode: 'commandcode_cli_source',
  grok: 'grok_cli_source',
  kimi: 'kimi_cli_source',
  antigravity: 'antigravity_cli_source',
  muse: 'muse_cli_source',
  devin: 'devin_cli_source',
  gh: 'gh_cli_source',
  glab: 'glab_cli_source',
}

const GH_LOGIN_ARGS = ['auth', 'login']

// Parallel installs each patch their CLI source. Local patch_preferences is
// load-merge-save and remote patches carry an expected revision, so
// concurrent patches can lose keys or conflict. Run them one at a time.
let patchQueue: Promise<unknown> = Promise.resolve()
export function queuePatch<T>(run: () => Promise<T>): Promise<T> {
  const next = patchQueue.catch(() => undefined).then(run)
  patchQueue = next
  return next
}

/** A timed-out Antigravity probe is unknown, not signed out. */
function isAuthenticated(cli: CliType, auth: AuthQuery): boolean {
  if (auth.data?.authenticated) return true
  return cli === 'antigravity' && !!auth.data?.timedOut
}

function loginArgsFor(cli: CliType, status: StatusLike | undefined) {
  if (cli === 'gh' || cli === 'glab') return GH_LOGIN_ARGS
  return loginArgsForBackend(cli, status?.supports_auth_command ?? true)
}

async function refetchCheck(
  cli: CliType,
  refetchStatus: () => Promise<{ data?: StatusLike } | undefined>,
  auth: AuthQuery,
  fallback: CliCheck
): Promise<CliCheck> {
  const status = await refetchStatus()
  const authResult = await auth.refetch()
  return {
    installed: status?.data?.installed ?? fallback.installed,
    authenticated: authResult?.data
      ? isAuthenticated(cli, { ...auth, data: authResult.data })
      : fallback.authenticated,
  }
}

function managedFlow(
  cli: Exclude<CliType, 'cursor'>,
  setup: ManagedSetup,
  auth: AuthQuery,
  path: PathQuery,
  preferences: AppPreferences | undefined,
  patch: PatchPreferences
): CliFlow {
  const sourceKey = SOURCE_KEYS[cli]
  const source = preferences?.[sourceKey] ?? null
  const installed = !!setup.status?.installed
  const authenticated = installed && isAuthenticated(cli, auth)
  const refetch = () =>
    refetchCheck(cli, setup.refetchStatus, auth, { installed, authenticated })

  return {
    cli,
    label: cliLabel(cli),
    installed,
    authenticated,
    ready: installed && authenticated,
    statusLoading: setup.isStatusLoading || !!path.isLoading,
    authLoading: installed && (auth.isLoading || auth.isFetching),
    pathFound: !!path.data?.found,
    pathPath: path.data?.path ?? null,
    source,
    installMode: 'managed',
    install: async () => {
      await patch({ [sourceKey]: 'jean' })
      let stable = setup.versions.filter(v => !v.prerelease)
      if (stable.length === 0) {
        const result = await setup.refetchVersions()
        stable = (result?.data ?? []).filter(v => !v.prerelease)
      }
      const version = stable[0]?.version
      if (!version) throw new Error('No stable version available.')
      await new Promise<void>((resolve, reject) => {
        setup.install(version, { onSuccess: resolve, onError: reject })
      })
      return refetch()
    },
    isInstalling: setup.isInstalling,
    installError: setup.installError,
    progress: setup.progress,
    usePath: async () => {
      await patch({ [sourceKey]: 'path' })
      return refetch()
    },
    refetch,
    loginCommand:
      (source === 'path' ? path.data?.path : null) ?? setup.status?.path ?? '',
    loginArgs: loginArgsFor(cli, setup.status),
  }
}

function cursorFlow(
  status: StatusQuery,
  auth: AuthQuery,
  path: PathQuery
): CliFlow {
  const installed = !!status.data?.installed
  const authenticated = installed && isAuthenticated('cursor', auth)
  const refetch = () =>
    refetchCheck('cursor', status.refetch, auth, { installed, authenticated })

  return {
    cli: 'cursor',
    label: cliLabel('cursor'),
    installed,
    authenticated,
    ready: installed && authenticated,
    statusLoading: status.isLoading || !!path.isLoading,
    authLoading: installed && (auth.isLoading || auth.isFetching),
    pathFound: installed || !!path.data?.found,
    pathPath: status.data?.path ?? path.data?.path ?? null,
    source: null,
    installMode: 'terminal',
    // The terminal installer runs in the checklist; afterwards just re-check.
    install: refetch,
    isInstalling: false,
    installError: null,
    progress: null,
    usePath: refetch,
    refetch,
    loginCommand: status.data?.path ?? path.data?.path ?? '',
    loginArgs: loginArgsFor('cursor', status.data),
  }
}

/**
 * Every hook is called unconditionally (rules of hooks), then normalized.
 */
export function useCliSetupFlows(): Record<CliType, CliFlow> {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const patch: PatchPreferences = p =>
    queuePatch(() => patchPreferences.mutateAsync(p))

  const claudeSetup = useClaudeCliSetup()
  const codexSetup = useCodexCliSetup()
  const opencodeSetup = useOpenCodeCliSetup()
  const cursorStatus = useCursorCliStatus()
  const piSetup = usePiCliSetup()
  const commandcodeSetup = useCommandCodeCliSetup()
  const grokSetup = useGrokCliSetup()
  const kimiSetup = useKimiCliSetup()
  const antigravitySetup = useAntigravityCliSetup()
  const museSetup = useMuseCliSetup()
  const devinSetup = useDevinCliSetup()
  const ghSetup = useGhCliSetup()
  const glabSetup = useGlabCliSetup()

  const claudePath = useClaudePathDetection()
  const codexPath = useCodexPathDetection()
  const opencodePath = useOpenCodePathDetection()
  const cursorPath = useCursorPathDetection()
  const piPath = usePiPathDetection()
  const commandcodePath = useCommandCodePathDetection()
  const grokPath = useGrokPathDetection()
  const kimiPath = useKimiPathDetection()
  const antigravityPath = useAntigravityPathDetection()
  const musePath = useMusePathDetection()
  const devinPath = useDevinPathDetection()
  const ghPath = useGhPathDetection()
  const glabPath = useGlabPathDetection()

  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeSetup.status?.installed,
  })
  const codexAuth = useCodexCliAuth({ enabled: !!codexSetup.status?.installed })
  const opencodeAuth = useOpenCodeCliAuth({
    enabled: !!opencodeSetup.status?.installed,
  })
  const cursorAuth = useCursorCliAuth({
    enabled: !!cursorStatus.data?.installed,
  })
  const piAuth = usePiCliAuth({ enabled: !!piSetup.status?.installed })
  const commandcodeAuth = useCommandCodeCliAuth({
    enabled: !!commandcodeSetup.status?.installed,
  })
  const grokAuth = useGrokCliAuth({ enabled: !!grokSetup.status?.installed })
  const kimiAuth = useKimiCliAuth({ enabled: !!kimiSetup.status?.installed })
  const antigravityAuth = useAntigravityCliAuth({
    enabled: !!antigravitySetup.status?.installed,
  })
  const museAuth = useMuseCliAuth({ enabled: !!museSetup.status?.installed })
  const devinAuth = useDevinCliAuth({ enabled: !!devinSetup.status?.installed })
  const ghAuth = useGhCliAuth({ enabled: !!ghSetup.status?.installed })
  const glabAuth = useGlabCliAuth({ enabled: !!glabSetup.status?.installed })

  const m = (
    cli: Exclude<CliType, 'cursor'>,
    setup: ManagedSetup,
    auth: AuthQuery,
    path: PathQuery
  ) => managedFlow(cli, setup, auth, path, preferences, patch)

  return {
    claude: m('claude', claudeSetup, claudeAuth, claudePath),
    codex: m('codex', codexSetup, codexAuth, codexPath),
    opencode: m('opencode', opencodeSetup, opencodeAuth, opencodePath),
    cursor: cursorFlow(cursorStatus, cursorAuth, cursorPath),
    pi: m('pi', piSetup, piAuth, piPath),
    commandcode: m(
      'commandcode',
      commandcodeSetup,
      commandcodeAuth,
      commandcodePath
    ),
    grok: m('grok', grokSetup, grokAuth, grokPath),
    kimi: m('kimi', kimiSetup, kimiAuth, kimiPath),
    antigravity: m(
      'antigravity',
      antigravitySetup,
      antigravityAuth,
      antigravityPath
    ),
    muse: m('muse', museSetup, museAuth, musePath),
    devin: m('devin', devinSetup, devinAuth, devinPath),
    gh: m('gh', ghSetup, ghAuth, ghPath),
    glab: m('glab', glabSetup, glabAuth, glabPath),
  }
}
