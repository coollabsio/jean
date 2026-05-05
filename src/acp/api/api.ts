import { useEffect, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'

export interface AcpSessionInfo {
  session_id: string
  provider: string
  /** Canonical ACP session configuration surface. The frontend derives
   *  model/mode/thought-level pickers from this generic ACP field. */
  config_options: unknown
  /** Latest ACP slash-command catalog snapshot. `null`/non-array means
   *  the agent has not advertised one yet. */
  available_commands: unknown
  log_path: string
  /**
   * `true` when the backend resumed an existing ACP session via
   * `session/resume`. Unlike `session/load`, resume does NOT cause the
   * agent to re-stream the transcript — the on-disk JSONL is preserved
   * and the frontend's local replay is what repopulates the UI.
   */
  resumed: boolean
  /**
   * Last agent-pushed session title (`session_info_update.title`),
   * loaded from the backend snapshot sidecar. `null` until the agent has
   * ever emitted one. The frontend hydrates the title slice from this on
   * resume so the title shows up without waiting for a fresh notification.
   */
  title: string | null
  /** `true` when the agent advertised `prompt_capabilities.image` during
   *  the `initialize` handshake. The UI MUST NOT offer image attachment
   *  unless this is `true`. */
  prompt_image: boolean
}

export interface AcpSessionSnapshot {
  session_id: string
  provider: string
  config_options: unknown
  available_commands: unknown
  title: string | null
  prompt_image: boolean
}

export interface AcpLocalSessionState {
  exists: boolean
  snapshot: AcpSessionSnapshot | null
  log_entries: AcpLogEntry[]
}

/**
 * Payload broadcast on the `acp:event` channel by the backend ACP snapshot
 * pipeline.
 *
 * `frame` is the SDK-deserialized [`SessionNotification`] body (camelCase,
 * with `update.sessionUpdate` discriminating the variant). It is *not* a raw
 * JSON-RPC envelope.
 */
export interface AcpEventPayload {
  provider: string
  session_id: string | null
  /**
   * Stable jean session id stamped by the backend when the notification's
   * ACP session is bound to a Jean session. The backend buffers early
   * session notifications until that binding exists, then re-emits them
   * with this populated routing key.
   */
  jean_session_id: string | null
  frame: unknown
}

/**
 * Payload broadcast on the `acp:permission` channel when the agent sends
 * a `session/request_permission` request and the backend is parking on a
 * UI decision. Resolve via `acp_resolve_permission(request_id, optionId)`.
 */
export interface AcpPermissionPayload {
  provider: string
  session_id: string
  jean_session_id: string | null
  request_id: string
  /** Full camelCase `RequestPermissionRequest` payload — the UI walks
   *  `tool_call`/`toolCall` and `options` out of this. */
  request: unknown
}

export const acpQueryKeys = {
  all: ['acp'] as const,
  providers: ['acp', 'providers'] as const,
  localState: (jeanSessionId: string) =>
    [...acpQueryKeys.all, 'local-state', jeanSessionId] as const,
  createSession: (jeanSessionId: string) =>
    [...acpQueryKeys.all, 'create-session', jeanSessionId] as const,
  resumeSession: (jeanSessionId: string) =>
    [...acpQueryKeys.all, 'resume-session', jeanSessionId] as const,
  log: (jeanSessionId: string) =>
    [...acpQueryKeys.all, 'log', jeanSessionId] as const,
}

// ---------------------------------------------------------------------------
// Raw command wrappers (kept for tests / non-React callers).
// Prefer the React hooks below from components.
// ---------------------------------------------------------------------------

export function acpPing(): Promise<string> {
  return invoke<string>('acp_ping')
}

export interface AcpProviderInfo {
  id: string
  name: string
}

export function acpListProviders(): Promise<AcpProviderInfo[]> {
  return invoke<AcpProviderInfo[]>('acp_list_providers')
}

export function acpCreateSession(
  jeanSessionId: string,
  cwd: string,
  provider: string
): Promise<AcpSessionInfo> {
  return invoke<AcpSessionInfo>('acp_create_session', {
    jeanSessionId,
    cwd,
    provider,
  })
}

export function acpResumeSession(
  jeanSessionId: string,
  cwd: string
): Promise<AcpSessionInfo> {
  return invoke<AcpSessionInfo>('acp_resume_session', { jeanSessionId, cwd })
}

export interface AcpImageInput {
  data: string
  mime_type: string
}

export function acpSendMessage(
  jeanSessionId: string,
  text: string,
  images?: AcpImageInput[],
  mentions?: string[],
  worktreePath?: string
): Promise<unknown> {
  return invoke('acp_send_message', {
    jeanSessionId,
    text,
    images,
    mentions,
    worktreePath,
  })
}

export function acpCancel(jeanSessionId: string): Promise<void> {
  return invoke('acp_cancel', { jeanSessionId })
}

/**
 * Search the worktree for files matching `query`, used by the `@file`
 * mention popover. Honors `.gitignore`. Empty query returns the first
 * `limit` paths so the popover is useful the moment the user types `@`.
 */
export function acpSearchFiles(
  worktreePath: string,
  query: string,
  limit?: number
): Promise<string[]> {
  return invoke('acp_search_files', { worktreePath, query, limit })
}

export function acpSetModel(
  jeanSessionId: string,
  modelId: string
): Promise<unknown> {
  return invoke('acp_set_model', { jeanSessionId, modelId })
}

export function acpSetMode(
  jeanSessionId: string,
  modeId: string
): Promise<unknown> {
  return invoke('acp_set_mode', { jeanSessionId, modeId })
}

export function acpSetConfigOption(
  jeanSessionId: string,
  configId: string,
  valueId: string
): Promise<unknown> {
  return invoke('acp_set_config_option', { jeanSessionId, configId, valueId })
}

export function acpResolvePermission(
  requestId: string,
  optionId: string | null
): Promise<void> {
  return invoke('acp_resolve_permission', { requestId, optionId })
}

export interface AcpLogEntry {
  ts: number
  dir: string
  frame: unknown
}

export function hasPersistedAcpSession(
  state: AcpLocalSessionState | null | undefined
): boolean {
  return state?.exists === true && state.snapshot != null
}

export function acpLoadSessionLog(
  jeanSessionId: string
): Promise<AcpLogEntry[]> {
  return invoke('acp_load_session_log', { jeanSessionId })
}

export function acpLoadLocalSessionState(
  jeanSessionId: string
): Promise<AcpLocalSessionState> {
  return invoke('acp_load_local_session_state', { jeanSessionId })
}

// listenAcpEvents removed — the global singleton in
// `useAcpStreamingEvents` owns the single `acp:event` listener and writes
// straight into the per-session log cache. Components consume the cache via
// `useAcpSessionLog` instead of subscribing themselves.

// ---------------------------------------------------------------------------
// React Query hooks
// ---------------------------------------------------------------------------

/**
 * Fetch the static list of known ACP providers. Cached for the app
 * lifetime — the list is determined at build time and never changes
 * at runtime.
 */
export function useAcpListProviders() {
  return useQuery({
    queryKey: acpQueryKeys.providers,
    queryFn: acpListProviders,
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/**
 * Create a brand-new ACP session bound to a jean session. **Lazy** —
 * `enabled: false` so the heavy `session/new` round trip doesn't fire
 * until the caller explicitly invokes `refetch()` (typically from the
 * first-send flow after the user has chosen a provider locally).
 */
export function useAcpCreateSession(
  jeanSessionId: string,
  worktreePath: string,
  provider: string | null
) {
  const providerRef = useRef(provider)
  useEffect(() => {
    providerRef.current = provider
  }, [provider])
  return useQuery({
    queryKey: acpQueryKeys.createSession(jeanSessionId),
    queryFn: () => {
      const currentProvider = providerRef.current
      if (!currentProvider) {
        return Promise.reject(new Error('no acp provider selected'))
      }
      return acpCreateSession(jeanSessionId, worktreePath, currentProvider)
    },
    enabled: false,
    // The session lives for the app lifetime; never refetch.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

/**
 * Load the local persisted ACP transcript + snapshot for first paint.
 * Always enabled for existing jean sessions so the UI can decide whether
 * to show a provider chooser or a restored ACP chat before resume finishes.
 */
export function useAcpLocalSessionState(jeanSessionId: string | undefined) {
  const enabled = typeof jeanSessionId === 'string' && jeanSessionId.length > 0
  return useQuery({
    queryKey: acpQueryKeys.localState(jeanSessionId ?? ''),
    queryFn: () => {
      if (!enabled || !jeanSessionId) {
        return Promise.reject(new Error('no jean session id'))
      }
      return acpLoadLocalSessionState(jeanSessionId)
    },
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/**
 * Resume the existing ACP session bound to a jean session. Also lazy —
 * the caller explicitly triggers it when opening a tab that already has a
 * persisted ACP transcript/snapshot.
 */
export function useAcpResumeSession(
  jeanSessionId: string,
  worktreePath: string
) {
  return useQuery({
    queryKey: acpQueryKeys.resumeSession(jeanSessionId),
    queryFn: () => acpResumeSession(jeanSessionId, worktreePath),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

/**
 * Send a prompt to a known ACP session. Takes the jean session id per-call
 * (not at hook-construction time) so callers don't trip on closure
 * staleness right after a lazy session creation.
 */
export function useAcpSendMessage() {
  return useMutation({
    mutationFn: ({
      jeanSessionId,
      text,
      images,
      mentions,
      worktreePath,
    }: {
      jeanSessionId: string
      text: string
      images?: AcpImageInput[]
      mentions?: string[]
      worktreePath?: string
    }) => acpSendMessage(jeanSessionId, text, images, mentions, worktreePath),
  })
}

export function useAcpCancel() {
  return useMutation({
    mutationFn: ({ jeanSessionId }: { jeanSessionId: string }) =>
      acpCancel(jeanSessionId),
  })
}

export function useAcpSetModel(jeanSessionId: string) {
  return useMutation({
    mutationFn: (modelId: string) => acpSetModel(jeanSessionId, modelId),
  })
}

export function useAcpSetMode(jeanSessionId: string) {
  return useMutation({
    mutationFn: (modeId: string) => acpSetMode(jeanSessionId, modeId),
  })
}

export function useAcpSetConfigOption(jeanSessionId: string) {
  return useMutation({
    mutationFn: ({
      configId,
      valueId,
    }: {
      configId: string
      valueId: string
    }) => acpSetConfigOption(jeanSessionId, configId, valueId),
  })
}

/**
 * Cold-load the persisted JSONL transcript for a session. Used once per
 * session per app run to seed the Zustand `acp-store` via `hydrateFromLog`.
 * Keyed by *jean* session id (stable), not the volatile ACP session id.
 *
 * `staleTime: Infinity` so tab switches never refetch from disk. The
 * store's `hydrated[sid]` flag also short-circuits double-hydration if
 * the queryFn somehow runs twice. Live event mirroring no longer touches
 * this cache — `useAcpStreamingEvents` writes straight to the store.
 */
export function useAcpSessionLog(jeanSessionId: string | undefined) {
  const enabled = typeof jeanSessionId === 'string' && jeanSessionId.length > 0
  return useQuery({
    queryKey: acpQueryKeys.log(jeanSessionId ?? ''),
    queryFn: () => {
      if (!enabled || !jeanSessionId) {
        return Promise.reject(new Error('no jean session id'))
      }
      return acpLoadSessionLog(jeanSessionId)
    },
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  })
}
