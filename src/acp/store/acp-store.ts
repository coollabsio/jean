import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

/** Discriminated union for tool call output blocks (mirrors ACP's
 *  `ToolCallContent` enum: standard content, file diff, terminal embed). */
export type AcpToolCallContent =
  | { type: 'content'; text?: string }
  | { type: 'diff'; path: string; oldText?: string; newText: string }
  | { type: 'terminal'; terminalId: string }

/** ACP `ToolKind` enum — drives the icon and any kind-specific
 *  rendering. Mirrors `agent-client-protocol-schema`. */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

/** ACP `ToolCallStatus` enum: `pending → in_progress → completed | failed`. */
export type AcpToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'

export interface AcpToolCall {
  id: string
  /** Human-readable label provided by the agent (e.g. "Read /tmp/x.txt").
   *  Falls back to kind / "tool" if the agent omits it on the initial frame. */
  title: string
  /** Categorical kind drives the icon. */
  kind: AcpToolKind
  /** Lifecycle status. */
  status: AcpToolCallStatus
  /** Raw input the tool was called with (e.g. `{ command: "ls" }`). Free-form. */
  rawInput?: unknown
  /** Raw output once completed. Free-form. */
  rawOutput?: unknown
  /** File locations affected — surfaced for the "follow-along" UX. */
  locations?: { path: string; line?: number }[]
  /** Output blocks (text, diff, terminal). Per spec, updates *replace*
   *  this list rather than appending. */
  content?: AcpToolCallContent[]
}

/**
 * Single ordered timeline of agent emissions per turn. Text and thinking
 * are coalesced with the *previous* same-kind block (so a tool call
 * between two text chunks splits them into two text blocks instead of
 * silently merging them); tool calls always get their own block, keyed
 * by id so subsequent `tool_call_update` frames mutate-in-place.
 *
 * Replaces the prior trio (`streamingText`/`streamingThinking`/
 * `streamingToolCalls`) which lost the interleaving order — agents
 * routinely narrate, call a tool, narrate again, and the old shape
 * bunched all text on one side and all tools on the other.
 */
export type AcpAssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; call: AcpToolCall }
  | { kind: 'plan'; entries: AcpPlanEntry[] }

export interface AcpPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

export type AcpUiMessage =
  | {
      id: string
      role: 'user'
      text: string
      images?: { data: string; mimeType: string }[]
      mentions?: string[]
    }
  | {
      id: string
      role: 'assistant'
      blocks: AcpAssistantBlock[]
      /** ACP `stopReason` from the `session/prompt` response. Spec
       *  guarantees one of `end_turn`/`max_tokens`/`max_turn_requests`/
       *  `refusal`/`cancelled`. Only attached on finalize/replay; the
       *  UI renders a footer for anything other than `end_turn`. */
      stopReason?: string
    }

export interface AcpModelInfo {
  id: string
  name: string
  description?: string
}

export interface AcpModeInfo {
  id: string
  name: string
  description?: string
}

export interface AcpThoughtLevelInfo {
  id: string
  name: string
  description?: string
}

export type AcpConfigSemantic = 'model' | 'mode' | 'thought_level'

/**
 * Slash command advertised by the agent via `available_commands_update`.
 * `input.hint` is shown next to the command name as an argument hint and
 * helps explain what usually comes after `/name`. Picking any command keeps
 * `/name ` in the composer so the user can review or add args before sending.
 *
 * The protocol's `AvailableCommandInput` is currently a single-variant
 * `unstructured` enum, so we flatten it down to just `{ hint }` here.
 */
export interface AcpAvailableCommand {
  name: string
  description: string
  input?: { hint: string }
}

export interface AcpPendingImage {
  id: string
  /** Raw base64 data (no `data:` prefix) to send to the agent. Empty while loading. */
  data: string
  mimeType: string
  /** Object URL for <img> preview — revoke on remove/clear. */
  previewUrl: string
  /** True while the image is being read + processed. */
  loading?: boolean
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  /** Wire kind from the agent: e.g. `allow_once`, `allow_always`,
   *  `reject_once`, `reject_always`. Used purely for styling/ordering;
   *  resolution sends the opaque `optionId` back. */
  kind?: string
}

export interface AcpPendingPermission {
  requestId: string
  /** Tool the agent wants permission for (`tool_call.title`/`kind`). */
  toolTitle?: string
  toolKind?: string
  /** Free-form description if the agent attached one. */
  description?: string
  options: AcpPermissionOption[]
}

/**
 * Latest `usage_update` snapshot for a session. The agent emits these
 * frequently as it streams; we track only the most recent one for the
 * status strip. Cost is reported separately (only on the terminal
 * `session/prompt` response in the example we've seen) so we keep the
 * last seen amount sticky across subsequent chunk-only updates.
 */
export interface AcpUsage {
  /** Maximum context window size in tokens. */
  size?: number
  /** Tokens used in the current context. */
  used?: number
  /** Cumulative chat cost. Sticky — kept across non-cost usage updates. */
  costAmount?: number
  /** ISO 4217 currency code. */
  costCurrency?: string
}

interface AcpState {
  /**
   * Finalized message history per jean session id. Includes:
   *   - the disk JSONL replay loaded once on first mount (`hydrateFromLog`)
   *   - user prompts pushed via `pushUserMessage`
   *   - assistant turns "locked in" via `finalizeStreamingAssistant`
   * Never mutated by per-chunk live events directly — those land in the
   * `streaming*` maps and only graduate into `messages` on finalize.
   */
  messages: Record<string, AcpUiMessage[]>

  /**
   * In-flight assistant turn as an ordered timeline of blocks. Replaces
   * the prior trio of separate text/thinking/toolCalls maps so we can
   * faithfully render the agent's narration → tool → narration → tool
   * sequence. Each event from the agent either extends the trailing
   * same-kind block (text/thinking) or appends a new one (tool call).
   */
  streamingBlocks: Record<string, AcpAssistantBlock[]>

  /**
   * Sessions whose disk log has already been folded into `messages`. Guards
   * against double-hydration when `AcpChat` remounts and `useAcpSessionLog`
   * resolves a second time. Also set inside `clearSession` so resume
   * doesn't re-load the (now-truncated) disk file on the next remount.
   */
  hydrated: Record<string, true>

  /**
   * Per-session current model id. Canonical source is the agent's generic
   * `configOptions` payload; we persist the derived current value here for
   * cheap selectors / optimistic updates.
   */
  currentModelId: Record<string, string>

  /** Per-session catalog of selectable models. Stable for the lifetime
   * of the session (the spec has no mid-session "models changed" signal). */
  availableModels: Record<string, AcpModelInfo[]>
  /** Actual config-option id backing the model picker when sourced from
   *  ACP `configOptions` (usually `"model"`). Used for correctness when
   *  sending `session/set_config_option`. */
  modelConfigId: Record<string, string>

  /**
   * Per-session current mode id. Canonical source is `configOptions`; this
   * stored value is the derived selector target plus the optimistic-update
   * rollback point. Also updated by spec-defined `current_mode_update`
   * notifications.
   */
  currentModeId: Record<string, string>

  /** Per-session catalog of selectable modes. Stable for the lifetime
   * of the session (mirrors `availableModels`). */
  availableModes: Record<string, AcpModeInfo[]>
  /** Actual config-option id backing the mode picker. */
  modeConfigId: Record<string, string>

  /**
   * Per-session current thought-level value id. Canonical source is the
   * agent's generic `configOptions`.
   */
  currentThoughtLevelId: Record<string, string>

  /** Per-session catalog of selectable thought-level options. */
  availableThoughtLevels: Record<string, AcpThoughtLevelInfo[]>
  /** Actual config-option id backing the thought-level picker
   *  (e.g. `"effort"` for Claude, `"reasoning_effort"` for Codex). */
  thoughtLevelConfigId: Record<string, string>

  /**
   * Per-session catalog of agent-advertised slash commands. Hydrated from
   * `available_commands_update` SessionUpdate notifications — the agent
   * sends a full snapshot on each change, so we replace wholesale rather
   * than merging. Empty (or missing) → slash popover renders nothing.
   */
  availableCommands: Record<string, AcpAvailableCommand[]>

  /**
   * Pending `session/request_permission` requests, keyed by jean session
   * id. Each entry is a queue (FIFO) — agents may send multiple in
   * flight, and we render the head while the rest wait. `addPermission`
   * appends, `removePermission` removes by request id (called on resolve).
   */
  pendingPermissions: Record<string, AcpPendingPermission[]>

  /**
   * Latest usage snapshot per session — context size/used and the most
   * recent cost amount. Updated by `applyUsageUpdate` from both the live
   * `usage_update` SessionUpdate stream and the `session/prompt` response
   * envelope (which carries the final cost on turn end).
   */
  usage: Record<string, AcpUsage>

  // -------------------------------------------------------------------------
  // Mutations — every one returns the prior state on no-op so subscribers
  // don't re-render unnecessarily (see CLAUDE.md "Zustand Store Mutation
  // Guards").
  // -------------------------------------------------------------------------

  /** Append `chunk` to the trailing text block of the current streaming
   *  turn, or push a new text block if the trailing block isn't text.
   *  No-op for empty chunks. */
  appendStreamingText: (sid: string, chunk: string) => void

  /** Same as `appendStreamingText` but for thinking/reasoning. */
  appendStreamingThinking: (sid: string, chunk: string) => void

  /**
   * Insert or merge a tool call frame. The agent sends a full `tool_call`
   * once and zero-or-more `tool_call_update` frames after; the latter
   * carry only the changed fields, so the caller passes a partial. We
   * locate any prior tool block by id and merge in place; otherwise a
   * new tool block is appended at the end of the timeline. Per ACP spec,
   * collection fields (content, locations) are overwritten, not appended.
   */
  upsertStreamingToolCall: (
    sid: string,
    call: { id: string } & Partial<AcpToolCall>
  ) => void

  /** Replace the plan block in the current streaming turn. Per spec, every
   *  `plan` update is a full snapshot — clients replace wholesale, never patch.
   *  If no plan block exists yet it is appended at the end of the timeline. */
  upsertStreamingPlan: (sid: string, entries: AcpPlanEntry[]) => void

  /**
   * Append an optimistic user message to `messages[sid]`. **Always finalizes
   * any pending streaming assistant first**, so a user prompt sent
   * mid-stream (e.g. after the user reads the assistant's reply and types a
   * follow-up) cleanly closes out the prior assistant turn before
   * appending. Idempotent: passing the same `id` twice (the optimistic
   * id from `handleSend` and the disk replay id later) is fine because
   * the disk version arrives via hydrate, which happens at-most-once
   * per session.
   */
  pushUserMessage: (
    sid: string,
    text: string,
    images?: { data: string; mimeType: string }[],
    idSeed?: string,
    mentions?: string[]
  ) => void

  /**
   * Lock in the current streaming buffer as a finalized assistant message.
   * No-op when all three streaming buffers are empty. Called from:
   *   - `pushUserMessage` (next-turn implicit finalize)
   *   - the `useAcpSendMessage` mutation's `onSettled` (in-mount explicit)
   * Both paths are idempotent so missing one (e.g. tab switch unmounts
   * before settle fires) doesn't strand the message.
   *
   * `stopReason` is attached to the finalized message when known (the
   * `onSettled` path passes it from the `session/prompt` response).
   * Implicit finalizes from `pushUserMessage` always omit it — the new
   * user prompt is what's locking in the prior turn, so we have no
   * structured stop reason to attribute.
   */
  finalizeStreamingAssistant: (sid: string, stopReason?: string) => void

  /**
   * Fold the persisted JSONL transcript into `messages`. No-op if already
   * hydrated. Entries are the raw shape returned by `acpLoadSessionLog`
   * (`{ ts, dir, frame }`).
   */
  hydrateFromLog: (sid: string, entries: AcpLogEntryShape[]) => void

  /**
   * Reset every map for `sid`. Held over from when the resume path
   * truncated the disk replay; today `session/resume` preserves the
   * JSONL file so this is rarely needed. Marks the session as already
   * hydrated so the disk-load query doesn't re-fold the file when
   * AcpChat next mounts.
   */
  clearSession: (sid: string) => void

  /**
   * Hydrate the model catalog + current selection for a session. No-op if
   * the (currentId, available) pair already matches what we have. Called
   * once per session lifetime from `AcpChat` after `sessionQuery` resolves.
   */
  setSessionModels: (
    sid: string,
    currentId: string,
    available: AcpModelInfo[],
    configId?: string
  ) => void

  /**
   * Locally flip the current model. Used both for optimistic update before
   * `acp_set_model` and for rollback on its failure. No-op when the value
   * doesn't change.
   */
  setCurrentModelId: (sid: string, modelId: string) => void

  /**
   * Hydrate the mode catalog + current selection for a session. Mirrors
   * `setSessionModels`: idempotent, called once per session lifetime
   * after the session create/resume response lands.
   */
  setSessionModes: (
    sid: string,
    currentId: string,
    available: AcpModeInfo[],
    configId?: string
  ) => void

  /** Optimistic mode flip + rollback target. Mirrors `setCurrentModelId`. */
  setCurrentModeId: (sid: string, modeId: string) => void

  /**
   * Hydrate the thought-level catalog + current selection for a session.
   * Mirrors `setSessionModes` exactly. Idempotent.
   */
  setSessionThoughtLevels: (
    sid: string,
    currentId: string,
    available: AcpThoughtLevelInfo[],
    configId?: string
  ) => void

  /** Optimistic thought-level flip + rollback target. Mirrors `setCurrentModeId`. */
  setCurrentThoughtLevelId: (sid: string, thoughtLevelId: string) => void

  /**
   * Replace the per-session slash command catalog wholesale. Called from
   * the `available_commands_update` SessionUpdate handler — the agent
   * always sends a full snapshot, never a delta.
   */
  setSessionCommands: (sid: string, commands: AcpAvailableCommand[]) => void

  /**
   * Per-session most-recent agent-pushed title
   * (`session_info_update.title`). Hydrated from `AcpSessionInfo.title`
   * at create/resume time and updated live by the streaming handler.
   * Missing key (or `null`) means the agent hasn't sent one (or
   * explicitly cleared it). Pure data slice — display and wiring to the
   * jean chat-store rename happens in `AcpChat`.
   */
  sessionTitles: Record<string, string | null>
  setSessionTitle: (sid: string, title: string | null) => void

  /**
   * Latest plan snapshot for each session — updated on every `plan`
   * SessionUpdate and seeded from replay. Separate from the inline
   * timeline block so the sticky panel above the composer can read it
   * without walking all messages. `null` = no plan ever received.
   */
  sessionPlan: Record<string, AcpPlanEntry[] | null>
  setSessionPlan: (sid: string, entries: AcpPlanEntry[] | null) => void

  /**
   * Per-session image-prompt capability flag. `true` when the agent's
   * `initialize` response advertised `prompt_capabilities.image`. Hydrated
   * once from `AcpSessionInfo.prompt_image` at create/resume time. Defaults
   * to `false` (absent key) — the UI must not offer image attachment until
   * this is confirmed.
   */
  promptImageSupported: Record<string, boolean>
  setPromptImageSupported: (sid: string, supported: boolean) => void

  /**
   * Images staged for the next send in each session. Each entry holds the
   * processed base64 data (no `data:` prefix), MIME type, and a local
   * object-URL for preview rendering. Cleared after a successful send.
   */
  pendingImages: Record<string, AcpPendingImage[]>
  addPendingImage: (sid: string, img: AcpPendingImage) => void
  updatePendingImage: (
    sid: string,
    id: string,
    patch: Partial<AcpPendingImage>
  ) => void
  removePendingImage: (sid: string, id: string) => void
  clearPendingImages: (sid: string) => void

  /** Append a pending permission request to the session's queue. No-op
   *  if a request with the same id is already queued (defensive against
   *  duplicate emits). */
  addPendingPermission: (sid: string, req: AcpPendingPermission) => void

  /** Remove a pending permission by request id (called once we've sent
   *  the resolve back to the backend). */
  removePendingPermission: (sid: string, requestId: string) => void

  /** Merge a usage snapshot. Each field updates only if defined in
   *  `patch`, so a chunk-only `usage_update` (size+used, no cost)
   *  doesn't clobber the last-seen sticky cost. No-op when nothing
   *  actually changes. */
  applyUsageUpdate: (sid: string, patch: AcpUsage) => void
}

interface AcpLogEntryShape {
  ts: number
  dir: string
  frame: unknown
}

const EMPTY_MESSAGES: AcpUiMessage[] = []
const EMPTY_BLOCKS: AcpAssistantBlock[] = []
const EMPTY_MODELS: AcpModelInfo[] = []
const EMPTY_MODES: AcpModeInfo[] = []
const EMPTY_THOUGHT_LEVELS: AcpThoughtLevelInfo[] = []
const EMPTY_COMMANDS: AcpAvailableCommand[] = []
const EMPTY_PERMS: AcpPendingPermission[] = []
const EMPTY_IMAGES: AcpPendingImage[] = []
const EMPTY_USAGE: AcpUsage = {}

function omitRecordKey<T extends Record<string, unknown>>(
  obj: T,
  key: string
): T {
  const { [key]: _omitted, ...rest } = obj
  return rest as T
}

/** Drop entries whose value is `undefined` so the spread merge below
 *  doesn't clobber an existing populated field with an absent one
 *  from a partial `tool_call_update` payload. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const k in obj) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}

/** Cheap structural compare for the no-op guard. JSON.stringify is fine
 *  here — tool calls are small and infrequent vs streaming text. */
function toolCallsEqual(a: AcpToolCall, b: AcpToolCall): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.kind === b.kind &&
    a.status === b.status &&
    JSON.stringify(a.rawInput) === JSON.stringify(b.rawInput) &&
    JSON.stringify(a.rawOutput) === JSON.stringify(b.rawOutput) &&
    JSON.stringify(a.locations) === JSON.stringify(b.locations) &&
    JSON.stringify(a.content) === JSON.stringify(b.content)
  )
}

/** Append a text/thinking chunk to the trailing same-kind block, or push
 *  a new block if the trailing block isn't of the same kind. Returning a
 *  fresh array (never mutating in place) is required for Zustand subscribers
 *  to notice the change. */
function appendInline(
  blocks: AcpAssistantBlock[],
  kind: 'text' | 'thinking',
  chunk: string
): AcpAssistantBlock[] {
  const last = blocks[blocks.length - 1]
  if (last && last.kind === kind) {
    const next = blocks.slice()
    next[blocks.length - 1] = { kind, text: last.text + chunk }
    return next
  }
  return [...blocks, { kind, text: chunk }]
}

/** Generic select-config-option parser. Pulls the entry whose
 *  `id`/`category` matches `key` (e.g. "thought_level", "model", "mode") out of
 *  the agent's `configOptions` array, normalizes it to the
 *  `{ currentId, available: [{ id, name, description? }] }` shape every
 *  setter in this module uses. The configOptions wire shape uses
 *  `value`/`name`/`description` for each entry — not the asymmetric
 *  `modelId` (models) / `id` (modes) you see on the top-level
 *  session/new response, so this rewrite makes one validator do the job
 *  for all three. Supports both flat and grouped select options. Returns
 *  `null` when the entry is missing or the options list is empty. */
export function parseSelectConfigOption<
  T extends { id: string; name: string; description?: string },
>(
  configOptions: unknown,
  key: string
): { currentId: string; available: T[] } | null {
  if (!Array.isArray(configOptions)) return null
  const entry = configOptions.find(o => {
    if (!o || typeof o !== 'object') return false
    const item = o as Record<string, unknown>
    return item.id === key || item.category === key
  }) as Record<string, unknown> | undefined
  if (!entry) return null
  const currentId =
    typeof entry.currentValue === 'string' ? entry.currentValue : ''
  if (!currentId) return null
  const opts = entry.options
  if (!Array.isArray(opts)) return null
  const available: T[] = []
  const appendOption = (item: Record<string, unknown>) => {
    const id = item.value
    const name = item.name
    if (typeof id !== 'string' || !id) return
    if (typeof name !== 'string' || !name) return
    const description =
      typeof item.description === 'string' ? item.description : undefined
    available.push({ id, name, description } as T)
  }
  for (const o of opts) {
    if (!o || typeof o !== 'object') continue
    const item = o as Record<string, unknown>
    if (Array.isArray(item.options)) {
      for (const nested of item.options) {
        if (!nested || typeof nested !== 'object') continue
        appendOption(nested as Record<string, unknown>)
      }
      continue
    }
    appendOption(item)
  }
  if (available.length === 0) return null
  return { currentId, available }
}

function configOptionMatchesSemantic(
  item: Record<string, unknown>,
  semantic: AcpConfigSemantic
): boolean {
  const id = typeof item.id === 'string' ? item.id : ''
  const name = typeof item.name === 'string' ? item.name : ''
  const description =
    typeof item.description === 'string' ? item.description : ''
  const category = typeof item.category === 'string' ? item.category : ''
  const haystack = `${id} ${name} ${description} ${category}`.toLowerCase()
  switch (semantic) {
    case 'model':
      return (
        category === 'model' || id === 'model' || /\bmodel\b/.test(haystack)
      )
    case 'mode':
      return category === 'mode' || id === 'mode' || /\bmode\b/.test(haystack)
    case 'thought_level':
      // Correctness always uses the option's actual `id`; this mapping is
      // UX-only so we can surface a single spec-aligned thought-level
      // picker across providers. ACP standardizes `thought_level`; some
      // providers use "effort"/"reasoning" naming instead. Match
      // semantics, never rely on a single hardcoded option id for
      // correctness.
      return (
        category === 'thought_level' ||
        category === 'effort' ||
        id === 'reasoning_effort' ||
        id === 'effort' ||
        /\b(thought|thinking|reasoning|effort|depth)\b/.test(haystack)
      )
    default:
      return false
  }
}

export function parseSemanticSelectConfigOption<
  T extends { id: string; name: string; description?: string },
>(
  configOptions: unknown,
  semantic: AcpConfigSemantic
): { configId: string; currentId: string; available: T[] } | null {
  if (!Array.isArray(configOptions)) return null
  let fallback: { configId: string; currentId: string; available: T[] } | null =
    null

  for (const option of configOptions) {
    if (!option || typeof option !== 'object') continue
    const entry = option as Record<string, unknown>
    const configId = typeof entry.id === 'string' ? entry.id : ''
    if (!configId) continue
    const parsed = parseSelectConfigOption<T>([entry], configId)
    if (!parsed) continue
    if (!configOptionMatchesSemantic(entry, semantic)) continue

    const category = typeof entry.category === 'string' ? entry.category : ''
    const exact =
      (semantic === 'model' &&
        (category === 'model' || configId === 'model')) ||
      (semantic === 'mode' && (category === 'mode' || configId === 'mode')) ||
      (semantic === 'thought_level' &&
        (category === 'thought_level' ||
          category === 'effort' ||
          configId === 'reasoning_effort' ||
          configId === 'effort'))

    const candidate = {
      configId,
      currentId: parsed.currentId,
      available: parsed.available,
    }
    if (exact) return candidate
    fallback = fallback ?? candidate
  }

  return fallback
}

/** Pull a usage patch out of any frame shape that might carry one:
 *  the live `usage_update` SessionUpdate (size/used/optional cost), and
 *  the `session/prompt` JSON-RPC response envelope (cost on the result).
 *  Returns `null` when nothing relevant is present. */
export function parseUsagePatch(frame: unknown): AcpUsage | null {
  if (!frame || typeof frame !== 'object') return null
  const obj = frame as Record<string, unknown>
  const patch: AcpUsage = {}
  // a2c session update path
  const update = obj.update as Record<string, unknown> | undefined
  if (update && update.sessionUpdate === 'usage_update') {
    if (typeof update.size === 'number') patch.size = update.size
    if (typeof update.used === 'number') patch.used = update.used
    const cost = update.cost as Record<string, unknown> | undefined
    if (cost && typeof cost.amount === 'number') {
      patch.costAmount = cost.amount
      if (typeof cost.currency === 'string') patch.costCurrency = cost.currency
    }
  }
  // session/prompt response result.cost (some agents put it here)
  const result = obj.result as Record<string, unknown> | undefined
  if (result) {
    const cost = result.cost as Record<string, unknown> | undefined
    if (cost && typeof cost.amount === 'number') {
      patch.costAmount = cost.amount
      if (typeof cost.currency === 'string') patch.costCurrency = cost.currency
    }
  }
  if (
    patch.size === undefined &&
    patch.used === undefined &&
    patch.costAmount === undefined
  ) {
    return null
  }
  return patch
}

/**
 * Parse the `availableCommands` array from an `available_commands_update`
 * SessionUpdate. Returns `null` if the payload doesn't look like one (the
 * caller treats that as a no-op so an unrelated frame doesn't wipe the
 * existing list). Drops entries with no name; tolerates a missing
 * description by defaulting to empty string.
 */
export function parseAvailableCommands(
  update: Record<string, unknown>
): AcpAvailableCommand[] | null {
  const raw = update.availableCommands
  if (!Array.isArray(raw)) return null
  const out: AcpAvailableCommand[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const name = obj.name
    if (typeof name !== 'string' || !name) continue
    const description =
      typeof obj.description === 'string' ? obj.description : ''
    let input: AcpAvailableCommand['input']
    const rawInput = obj.input
    if (rawInput && typeof rawInput === 'object') {
      const hint = (rawInput as Record<string, unknown>).hint
      if (typeof hint === 'string' && hint) input = { hint }
    }
    out.push({ name, description, input })
  }
  return out
}

/** Pull the typed AcpToolCall fields out of a loose `tool_call` /
 *  `tool_call_update` SessionUpdate payload. Used by both the live
 *  listener (`useAcpStreamingEvents`) and disk replay (`replayLog`)
 *  so they stay in sync. Missing fields stay `undefined` so the
 *  caller's merge keeps the prior value intact. */
export function parseToolCallFields(
  update: Record<string, unknown>,
  id: string
): { id: string } & Partial<AcpToolCall> {
  const title =
    typeof update.title === 'string' ? (update.title as string) : undefined
  const kind = parseToolKind(update.kind)
  const status = parseToolCallStatus(update.status)
  const rawInput = update.rawInput
  const rawOutput = update.rawOutput
  const locations = parseLocations(update.locations)
  const content = parseToolContent(update.content)
  return { id, title, kind, status, rawInput, rawOutput, locations, content }
}

const TOOL_KINDS: readonly AcpToolKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]

const TOOL_CALL_STATUSES: readonly AcpToolCallStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
]

function parseToolKind(raw: unknown): AcpToolKind | undefined {
  return typeof raw === 'string' &&
    (TOOL_KINDS as readonly string[]).includes(raw)
    ? (raw as AcpToolKind)
    : undefined
}

function parseToolCallStatus(raw: unknown): AcpToolCallStatus | undefined {
  return typeof raw === 'string' &&
    (TOOL_CALL_STATUSES as readonly string[]).includes(raw)
    ? (raw as AcpToolCallStatus)
    : undefined
}

function parseLocations(raw: unknown): AcpToolCall['locations'] {
  if (!Array.isArray(raw)) return undefined
  const out: { path: string; line?: number }[] = []
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue
    const item = l as Record<string, unknown>
    const path = item.path
    if (typeof path !== 'string' || !path) continue
    const line = typeof item.line === 'number' ? item.line : undefined
    out.push({ path, line })
  }
  return out.length ? out : undefined
}

function parseToolContent(raw: unknown): AcpToolCallContent[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: AcpToolCallContent[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const item = c as Record<string, unknown>
    const t = item.type
    if (t === 'diff') {
      const path = item.path
      const newText = item.newText
      if (typeof path !== 'string' || typeof newText !== 'string') continue
      const oldText =
        typeof item.oldText === 'string' ? item.oldText : undefined
      out.push({ type: 'diff', path, oldText, newText })
    } else if (t === 'terminal') {
      const terminalId = item.terminalId
      if (typeof terminalId !== 'string') continue
      out.push({ type: 'terminal', terminalId })
    } else if (t === 'content') {
      // Standard ContentBlock — for now we only surface its text. Other
      // variants (image, resource_link) keep their type marker so the UI
      // can display "[image]" placeholders if needed.
      const inner = item.content as Record<string, unknown> | undefined
      const text =
        inner && inner.type === 'text' && typeof inner.text === 'string'
          ? (inner.text as string)
          : undefined
      out.push({ type: 'content', text })
    }
  }
  return out.length ? out : undefined
}

export const useAcpStore = create<AcpState>()(
  devtools(
    (set, get) => ({
      messages: {},
      streamingBlocks: {},
      hydrated: {},
      currentModelId: {},
      availableModels: {},
      modelConfigId: {},
      currentModeId: {},
      availableModes: {},
      modeConfigId: {},
      currentThoughtLevelId: {},
      availableThoughtLevels: {},
      thoughtLevelConfigId: {},
      availableCommands: {},
      pendingPermissions: {},
      usage: {},
      sessionTitles: {},
      sessionPlan: {},
      promptImageSupported: {},
      pendingImages: {},

      appendStreamingText: (sid, chunk) => {
        if (!chunk) return
        set(
          state => ({
            streamingBlocks: {
              ...state.streamingBlocks,
              [sid]: appendInline(
                state.streamingBlocks[sid] ?? EMPTY_BLOCKS,
                'text',
                chunk
              ),
            },
          }),
          undefined,
          'appendStreamingText'
        )
      },

      appendStreamingThinking: (sid, chunk) => {
        if (!chunk) return
        set(
          state => ({
            streamingBlocks: {
              ...state.streamingBlocks,
              [sid]: appendInline(
                state.streamingBlocks[sid] ?? EMPTY_BLOCKS,
                'thinking',
                chunk
              ),
            },
          }),
          undefined,
          'appendStreamingThinking'
        )
      },

      upsertStreamingToolCall: (sid, call) => {
        set(
          state => {
            const prev = state.streamingBlocks[sid] ?? EMPTY_BLOCKS
            // Locate any prior tool block with this id — could be anywhere
            // in the timeline, not just at the tail (a later text block
            // may have been written after the tool started). Mutate in
            // place so streaming tool updates don't reorder.
            const idx = prev.findIndex(
              b => b.kind === 'tool' && b.call.id === call.id
            )
            if (idx >= 0) {
              const existing = (
                prev[idx] as { kind: 'tool'; call: AcpToolCall }
              ).call
              const merged: AcpToolCall = {
                ...existing,
                ...stripUndefined(call),
              }
              if (toolCallsEqual(existing, merged)) return state
              const next = prev.slice()
              next[idx] = { kind: 'tool', call: merged }
              return {
                streamingBlocks: { ...state.streamingBlocks, [sid]: next },
              }
            }
            // First sighting — fill defaults the agent might have omitted
            // and append at the *end* of the timeline (preserves narration
            // → tool ordering).
            const created: AcpToolCall = {
              id: call.id,
              title: call.title ?? call.kind ?? 'tool',
              kind: call.kind ?? 'other',
              status: call.status ?? 'pending',
              rawInput: call.rawInput,
              rawOutput: call.rawOutput,
              locations: call.locations,
              content: call.content,
            }
            return {
              streamingBlocks: {
                ...state.streamingBlocks,
                [sid]: [...prev, { kind: 'tool', call: created }],
              },
            }
          },
          undefined,
          'upsertStreamingToolCall'
        )
      },

      upsertStreamingPlan: (sid, entries) => {
        set(
          state => {
            const prev = state.streamingBlocks[sid] ?? EMPTY_BLOCKS
            const idx = prev.findIndex(b => b.kind === 'plan')
            let next: AcpAssistantBlock[]
            if (idx >= 0) {
              const existing = prev[idx] as {
                kind: 'plan'
                entries: AcpPlanEntry[]
              }
              const same =
                existing.entries.length === entries.length &&
                existing.entries.every(
                  (e, i) =>
                    e.content === entries[i]?.content &&
                    e.status === entries[i]?.status &&
                    e.priority === entries[i]?.priority
                )
              if (same) return state
              next = prev.slice()
              next[idx] = { kind: 'plan', entries }
            } else {
              next = [...prev, { kind: 'plan', entries }]
            }
            return {
              streamingBlocks: { ...state.streamingBlocks, [sid]: next },
              sessionPlan: { ...state.sessionPlan, [sid]: entries },
            }
          },
          undefined,
          'upsertStreamingPlan'
        )
      },

      pushUserMessage: (sid, text, images, idSeed, mentions) => {
        get().finalizeStreamingAssistant(sid)
        set(
          state => {
            const prev = state.messages[sid] ?? EMPTY_MESSAGES
            const id = `u-${idSeed ?? Date.now()}-${prev.length}`
            const msg: AcpUiMessage = {
              id,
              role: 'user',
              text,
              ...(images && images.length > 0 ? { images } : {}),
              ...(mentions && mentions.length > 0 ? { mentions } : {}),
            }
            return {
              messages: { ...state.messages, [sid]: [...prev, msg] },
            }
          },
          undefined,
          'pushUserMessage'
        )
      },

      finalizeStreamingAssistant: (sid, stopReason) => {
        set(
          state => {
            const blocks = state.streamingBlocks[sid] ?? EMPTY_BLOCKS
            if (blocks.length === 0) return state

            const prev = state.messages[sid] ?? EMPTY_MESSAGES
            const id = `a-${Date.now()}-${prev.length}`
            const finalized: AcpUiMessage = {
              id,
              role: 'assistant',
              blocks,
              stopReason,
            }

            const nextMessages = {
              ...state.messages,
              [sid]: [...prev, finalized],
            }
            const nextStreamingBlocks = omitRecordKey(
              state.streamingBlocks,
              sid
            )

            return {
              messages: nextMessages,
              streamingBlocks: nextStreamingBlocks,
            }
          },
          undefined,
          'finalizeStreamingAssistant'
        )
      },

      hydrateFromLog: (sid, entries) => {
        if (get().hydrated[sid]) return
        const folded = replayLog(entries)
        // Replay usage in chronological order so the *latest* size/used
        // and the latest cost both end up in the snapshot.
        let usage: AcpUsage | undefined
        for (const e of entries) {
          const patch = parseUsagePatch(e.frame)
          if (!patch) continue
          usage = {
            size: patch.size ?? usage?.size,
            used: patch.used ?? usage?.used,
            costAmount: patch.costAmount ?? usage?.costAmount,
            costCurrency: patch.costCurrency ?? usage?.costCurrency,
          }
        }
        set(
          state => {
            // Extract the last plan from the replayed messages for the
            // sticky panel — walk backwards to find the most recent one.
            let latestPlan: AcpPlanEntry[] | null = null
            for (let i = folded.length - 1; i >= 0; i--) {
              const msg = folded[i]
              if (msg?.role !== 'assistant') continue
              const planBlock = msg.blocks.find(b => b.kind === 'plan')
              if (planBlock && planBlock.kind === 'plan') {
                latestPlan = planBlock.entries
                break
              }
            }
            return {
              messages: { ...state.messages, [sid]: folded },
              hydrated: { ...state.hydrated, [sid]: true },
              usage: usage ? { ...state.usage, [sid]: usage } : state.usage,
              sessionPlan: latestPlan
                ? { ...state.sessionPlan, [sid]: latestPlan }
                : state.sessionPlan,
            }
          },
          undefined,
          'hydrateFromLog'
        )
      },

      clearSession: sid => {
        set(
          state => {
            const messages = omitRecordKey(state.messages, sid)
            const streamingBlocks = omitRecordKey(state.streamingBlocks, sid)
            const currentModelId = omitRecordKey(state.currentModelId, sid)
            const availableModels = omitRecordKey(state.availableModels, sid)
            const usage = omitRecordKey(state.usage, sid)
            const modelConfigId = omitRecordKey(state.modelConfigId, sid)
            const currentModeId = omitRecordKey(state.currentModeId, sid)
            const availableModes = omitRecordKey(state.availableModes, sid)
            const modeConfigId = omitRecordKey(state.modeConfigId, sid)
            const currentThoughtLevelId = omitRecordKey(
              state.currentThoughtLevelId,
              sid
            )
            const availableThoughtLevels = omitRecordKey(
              state.availableThoughtLevels,
              sid
            )
            const thoughtLevelConfigId = omitRecordKey(
              state.thoughtLevelConfigId,
              sid
            )
            const availableCommands = omitRecordKey(
              state.availableCommands,
              sid
            )
            // Mark hydrated even though we cleared messages: the disk file
            // was truncated by the backend before resume, so a subsequent
            // disk-load would yield nothing useful and would just race with
            // the agent's re-stream.
            const hydrated = { ...state.hydrated, [sid]: true as const }
            const sessionPlan = omitRecordKey(state.sessionPlan, sid)
            return {
              messages,
              streamingBlocks,
              hydrated,
              currentModelId,
              availableModels,
              usage,
              modelConfigId,
              currentModeId,
              availableModes,
              modeConfigId,
              currentThoughtLevelId,
              availableThoughtLevels,
              thoughtLevelConfigId,
              availableCommands,
              sessionPlan,
            }
          },
          undefined,
          'clearSession'
        )
      },

      setSessionModels: (sid, currentId, available, configId) => {
        set(
          state => {
            const prevAvail = state.availableModels[sid] ?? EMPTY_MODELS
            const prevCurrent = state.currentModelId[sid]
            const prevConfigId = state.modelConfigId[sid] ?? ''
            // Cheap structural compare — ids match in same order, current
            // unchanged → no-op. (Models lists are small; avoiding deep
            // equality libraries to keep bundle slim.)
            const sameAvail =
              prevAvail.length === available.length &&
              prevAvail.every((m, i) => {
                const next = available[i]
                return (
                  !!next &&
                  m.id === next.id &&
                  m.name === next.name &&
                  m.description === next.description
                )
              })
            if (
              sameAvail &&
              prevCurrent === currentId &&
              prevConfigId === (configId ?? '')
            ) {
              return state
            }
            return {
              availableModels: { ...state.availableModels, [sid]: available },
              currentModelId: { ...state.currentModelId, [sid]: currentId },
              modelConfigId: {
                ...state.modelConfigId,
                [sid]: configId ?? '',
              },
            }
          },
          undefined,
          'setSessionModels'
        )
      },

      setCurrentModelId: (sid, modelId) => {
        set(
          state => {
            if (state.currentModelId[sid] === modelId) return state
            return {
              currentModelId: { ...state.currentModelId, [sid]: modelId },
            }
          },
          undefined,
          'setCurrentModelId'
        )
      },

      setSessionModes: (sid, currentId, available, configId) => {
        set(
          state => {
            const prevAvail = state.availableModes[sid] ?? EMPTY_MODES
            const prevCurrent = state.currentModeId[sid]
            const prevConfigId = state.modeConfigId[sid] ?? ''
            const sameAvail =
              prevAvail.length === available.length &&
              prevAvail.every((m, i) => {
                const next = available[i]
                return (
                  !!next &&
                  m.id === next.id &&
                  m.name === next.name &&
                  m.description === next.description
                )
              })
            if (
              sameAvail &&
              prevCurrent === currentId &&
              prevConfigId === (configId ?? '')
            ) {
              return state
            }
            return {
              availableModes: { ...state.availableModes, [sid]: available },
              currentModeId: { ...state.currentModeId, [sid]: currentId },
              modeConfigId: {
                ...state.modeConfigId,
                [sid]: configId ?? '',
              },
            }
          },
          undefined,
          'setSessionModes'
        )
      },

      setCurrentModeId: (sid, modeId) => {
        set(
          state => {
            if (state.currentModeId[sid] === modeId) return state
            return {
              currentModeId: { ...state.currentModeId, [sid]: modeId },
            }
          },
          undefined,
          'setCurrentModeId'
        )
      },

      setSessionThoughtLevels: (sid, currentId, available, configId) => {
        set(
          state => {
            const prevAvail =
              state.availableThoughtLevels[sid] ?? EMPTY_THOUGHT_LEVELS
            const prevCurrent = state.currentThoughtLevelId[sid]
            const prevConfigId = state.thoughtLevelConfigId[sid] ?? ''
            const sameAvail =
              prevAvail.length === available.length &&
              prevAvail.every((m, i) => {
                const next = available[i]
                return (
                  !!next &&
                  m.id === next.id &&
                  m.name === next.name &&
                  m.description === next.description
                )
              })
            if (
              sameAvail &&
              prevCurrent === currentId &&
              prevConfigId === (configId ?? '')
            ) {
              return state
            }
            return {
              availableThoughtLevels: {
                ...state.availableThoughtLevels,
                [sid]: available,
              },
              currentThoughtLevelId: {
                ...state.currentThoughtLevelId,
                [sid]: currentId,
              },
              thoughtLevelConfigId: {
                ...state.thoughtLevelConfigId,
                [sid]: configId ?? '',
              },
            }
          },
          undefined,
          'setSessionThoughtLevels'
        )
      },

      setCurrentThoughtLevelId: (sid, thoughtLevelId) => {
        set(
          state => {
            if (state.currentThoughtLevelId[sid] === thoughtLevelId)
              return state
            return {
              currentThoughtLevelId: {
                ...state.currentThoughtLevelId,
                [sid]: thoughtLevelId,
              },
            }
          },
          undefined,
          'setCurrentThoughtLevelId'
        )
      },

      setSessionCommands: (sid, commands) => {
        set(
          state => {
            const prev = state.availableCommands[sid] ?? EMPTY_COMMANDS
            const same =
              prev.length === commands.length &&
              prev.every((c, i) => {
                const next = commands[i]
                return (
                  !!next &&
                  c.name === next.name &&
                  c.description === next.description &&
                  c.input?.hint === next.input?.hint
                )
              })
            if (same) return state
            return {
              availableCommands: {
                ...state.availableCommands,
                [sid]: commands,
              },
            }
          },
          undefined,
          'setSessionCommands'
        )
      },

      setSessionTitle: (sid, title) => {
        set(
          state => {
            const has = sid in state.sessionTitles
            const prev = state.sessionTitles[sid] ?? null
            if (has && prev === title) return state
            return {
              sessionTitles: { ...state.sessionTitles, [sid]: title },
            }
          },
          undefined,
          'setSessionTitle'
        )
      },

      setSessionPlan: (sid, entries) => {
        set(
          state => ({ sessionPlan: { ...state.sessionPlan, [sid]: entries } }),
          undefined,
          'setSessionPlan'
        )
      },

      setPromptImageSupported: (sid, supported) => {
        set(
          state => {
            if (state.promptImageSupported[sid] === supported) return state
            return {
              promptImageSupported: {
                ...state.promptImageSupported,
                [sid]: supported,
              },
            }
          },
          undefined,
          'setPromptImageSupported'
        )
      },

      addPendingImage: (sid, img) => {
        set(
          state => ({
            pendingImages: {
              ...state.pendingImages,
              [sid]: [...(state.pendingImages[sid] ?? []), img],
            },
          }),
          undefined,
          'addPendingImage'
        )
      },

      updatePendingImage: (sid, id, patch) => {
        set(
          state => {
            const prev = state.pendingImages[sid] ?? []
            const idx = prev.findIndex(i => i.id === id)
            if (idx === -1) return state
            const existing = prev[idx]
            if (!existing) return state
            const next = [...prev]
            next[idx] = { ...existing, ...patch }
            return { pendingImages: { ...state.pendingImages, [sid]: next } }
          },
          undefined,
          'updatePendingImage'
        )
      },

      removePendingImage: (sid, id) => {
        set(
          state => {
            const prev = state.pendingImages[sid] ?? []
            const next = prev.filter(i => i.id !== id)
            if (next.length === prev.length) return state
            return { pendingImages: { ...state.pendingImages, [sid]: next } }
          },
          undefined,
          'removePendingImage'
        )
      },

      clearPendingImages: sid => {
        set(
          state => {
            if (!state.pendingImages[sid]?.length) return state
            return { pendingImages: { ...state.pendingImages, [sid]: [] } }
          },
          undefined,
          'clearPendingImages'
        )
      },

      addPendingPermission: (sid, req) => {
        set(
          state => {
            const prev = state.pendingPermissions[sid] ?? EMPTY_PERMS
            if (prev.some(p => p.requestId === req.requestId)) return state
            return {
              pendingPermissions: {
                ...state.pendingPermissions,
                [sid]: [...prev, req],
              },
            }
          },
          undefined,
          'addPendingPermission'
        )
      },

      removePendingPermission: (sid, requestId) => {
        set(
          state => {
            const prev = state.pendingPermissions[sid] ?? EMPTY_PERMS
            const next = prev.filter(p => p.requestId !== requestId)
            if (next.length === prev.length) return state
            const map =
              next.length === 0
                ? omitRecordKey(state.pendingPermissions, sid)
                : { ...state.pendingPermissions, [sid]: next }
            return { pendingPermissions: map }
          },
          undefined,
          'removePendingPermission'
        )
      },

      applyUsageUpdate: (sid, patch) => {
        set(
          state => {
            const prev = state.usage[sid] ?? EMPTY_USAGE
            const merged: AcpUsage = {
              size: patch.size ?? prev.size,
              used: patch.used ?? prev.used,
              costAmount: patch.costAmount ?? prev.costAmount,
              costCurrency: patch.costCurrency ?? prev.costCurrency,
            }
            if (
              merged.size === prev.size &&
              merged.used === prev.used &&
              merged.costAmount === prev.costAmount &&
              merged.costCurrency === prev.costCurrency
            ) {
              return state
            }
            return { usage: { ...state.usage, [sid]: merged } }
          },
          undefined,
          'applyUsageUpdate'
        )
      },
    }),
    { name: 'acp-store', enabled: import.meta.env.DEV }
  )
)

// ---------------------------------------------------------------------------
// Stable selector helpers — return shared empty refs when a session has no
// entry yet, so subscribers don't re-render on object identity churn.
// ---------------------------------------------------------------------------

export const selectAcpMessages = (sid: string) => (state: AcpState) =>
  state.messages[sid] ?? EMPTY_MESSAGES
export const selectAcpStreamingBlocks = (sid: string) => (state: AcpState) =>
  state.streamingBlocks[sid] ?? EMPTY_BLOCKS
export const selectAcpHydrated = (sid: string) => (state: AcpState) =>
  state.hydrated[sid] === true
export const selectAcpAvailableModels = (sid: string) => (state: AcpState) =>
  state.availableModels[sid] ?? EMPTY_MODELS
export const selectAcpCurrentModelId = (sid: string) => (state: AcpState) =>
  state.currentModelId[sid]
export const selectAcpModelConfigId = (sid: string) => (state: AcpState) =>
  state.modelConfigId[sid]
export const selectAcpAvailableModes = (sid: string) => (state: AcpState) =>
  state.availableModes[sid] ?? EMPTY_MODES
export const selectAcpCurrentModeId = (sid: string) => (state: AcpState) =>
  state.currentModeId[sid]
export const selectAcpModeConfigId = (sid: string) => (state: AcpState) =>
  state.modeConfigId[sid]
export const selectAcpAvailableThoughtLevels =
  (sid: string) => (state: AcpState) =>
    state.availableThoughtLevels[sid] ?? EMPTY_THOUGHT_LEVELS
export const selectAcpCurrentThoughtLevelId =
  (sid: string) => (state: AcpState) =>
    state.currentThoughtLevelId[sid]
export const selectAcpThoughtLevelConfigId =
  (sid: string) => (state: AcpState) =>
    state.thoughtLevelConfigId[sid]
export const selectAcpAvailableCommands = (sid: string) => (state: AcpState) =>
  state.availableCommands[sid] ?? EMPTY_COMMANDS
export const selectAcpPendingPermissions = (sid: string) => (state: AcpState) =>
  state.pendingPermissions[sid] ?? EMPTY_PERMS
export const selectAcpUsage = (sid: string) => (state: AcpState) =>
  state.usage[sid] ?? EMPTY_USAGE
export const selectAcpSessionTitle = (sid: string) => (state: AcpState) =>
  state.sessionTitles[sid] ?? null
export const selectAcpSessionPlan = (sid: string) => (state: AcpState) =>
  state.sessionPlan[sid] ?? null
export const selectAcpPromptImageSupported =
  (sid: string) => (state: AcpState) =>
    state.promptImageSupported[sid] ?? false
export const selectAcpPendingImages = (sid: string) => (state: AcpState) =>
  state.pendingImages[sid] ?? EMPTY_IMAGES

// ---------------------------------------------------------------------------
// Disk replay folding. Pure function so it can also run inside hydrate.
// ---------------------------------------------------------------------------

/**
 * Fold the on-disk JSONL transcript into UiMessage state. Each c2a frame
 * with `method: "session/prompt"` becomes a user message; each a2c
 * SessionNotification flows through `applyUpdate`. Other c2a/a2c frames
 * (session/new, session/resume, session/cancel, session/set_model,
 * session/request_permission) are ignored for UI purposes — they're in
 * the log for debugging/replay, not for the rendered transcript.
 */
function replayLog(entries: AcpLogEntryShape[]): AcpUiMessage[] {
  let messages: AcpUiMessage[] = []
  for (const entry of entries) {
    const frame = entry.frame as Record<string, unknown> | undefined
    if (!frame) continue

    if (entry.dir === 'c2a') {
      const method = frame.method as string | undefined
      const params = (frame.params ?? {}) as Record<string, unknown>
      if (method === 'session/prompt') {
        const text = (params.text as string | undefined) ?? ''
        const rawImages = Array.isArray(params.images) ? params.images : []
        const images = rawImages.flatMap(i => {
          if (!i || typeof i !== 'object') return []
          const data = (i as Record<string, unknown>).data
          const mimeType = (i as Record<string, unknown>).mimeType
          if (typeof data !== 'string' || typeof mimeType !== 'string')
            return []
          return [{ data, mimeType }]
        })
        const mentions: string[] = []
        const seen = new Set<string>()
        for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
          const p = m[1]
          if (p && !seen.has(p)) {
            mentions.push(p)
            seen.add(p)
          }
        }
        messages = [
          ...messages,
          {
            id: `u-${entry.ts}`,
            role: 'user',
            text,
            ...(images.length > 0 ? { images } : {}),
            ...(mentions.length > 0 ? { mentions } : {}),
          } satisfies AcpUiMessage,
        ]
      }
      continue
    }

    if (entry.dir === 'a2c') {
      // Stop reason rides on the `session/prompt` JSON-RPC response (which
      // is logged with `{ method, result }` shape, not the SessionUpdate
      // shape). Stamp it onto the trailing assistant message so resumed
      // sessions surface the same footer as live ones.
      const method = frame.method as string | undefined
      if (method === 'session/prompt') {
        const result = (frame.result ?? {}) as Record<string, unknown>
        const stopReason = result.stopReason
        if (typeof stopReason === 'string' && stopReason) {
          const last = messages[messages.length - 1]
          if (last && last.role === 'assistant') {
            const next = messages.slice()
            next[messages.length - 1] = { ...last, stopReason }
            messages = next
          }
        }
        continue
      }

      const update = (frame.update ?? {}) as Record<string, unknown>
      const kind = update.sessionUpdate as string | undefined
      if (!kind) continue
      messages = applyUpdateToMessages(messages, kind, update, `${entry.ts}`)
    }
  }
  return messages
}

function applyUpdateToMessages(
  prev: AcpUiMessage[],
  kind: string,
  update: Record<string, unknown>,
  idSeed: string
): AcpUiMessage[] {
  /** Ensure the trailing message is an open assistant turn (with `blocks`).
   *  Returns the list as-is when it already ends with one. */
  const ensureAssistant = (): AcpUiMessage[] => {
    const last = prev[prev.length - 1]
    if (last && last.role === 'assistant') return prev
    return [
      ...prev,
      {
        id: `a-${idSeed}-${prev.length}`,
        role: 'assistant',
        blocks: [],
      },
    ]
  }

  const updateLastAssistantBlocks = (
    list: AcpUiMessage[],
    mut: (blocks: AcpAssistantBlock[]) => AcpAssistantBlock[]
  ): AcpUiMessage[] => {
    const idx = list.length - 1
    const last = list[idx]
    if (idx < 0 || !last || last.role !== 'assistant') return list
    const next = list.slice()
    next[idx] = { ...last, blocks: mut(last.blocks) }
    return next
  }

  switch (kind) {
    case 'agent_message_chunk': {
      const content = (update.content ?? {}) as { type?: string; text?: string }
      if (content.type !== 'text' || !content.text) return prev
      const text = content.text
      const list = ensureAssistant()
      return updateLastAssistantBlocks(list, blocks =>
        appendInline(blocks, 'text', text)
      )
    }
    case 'agent_thought_chunk': {
      const content = (update.content ?? {}) as { type?: string; text?: string }
      if (content.type !== 'text' || !content.text) return prev
      const text = content.text
      const list = ensureAssistant()
      return updateLastAssistantBlocks(list, blocks =>
        appendInline(blocks, 'thinking', text)
      )
    }
    case 'tool_call':
    case 'tool_call_update': {
      const id = (update.toolCallId as string | undefined) ?? ''
      if (!id) return prev
      const partial = parseToolCallFields(update, id)
      const list = ensureAssistant()
      return updateLastAssistantBlocks(list, blocks => {
        const existingIdx = blocks.findIndex(
          b => b.kind === 'tool' && b.call.id === id
        )
        if (existingIdx >= 0) {
          const existing = (
            blocks[existingIdx] as { kind: 'tool'; call: AcpToolCall }
          ).call
          const next = blocks.slice()
          next[existingIdx] = {
            kind: 'tool',
            call: { ...existing, ...stripUndefined(partial) },
          }
          return next
        }
        return [
          ...blocks,
          {
            kind: 'tool',
            call: {
              id,
              title: partial.title ?? partial.kind ?? 'tool',
              kind: partial.kind ?? 'other',
              status: partial.status ?? 'pending',
              rawInput: partial.rawInput,
              rawOutput: partial.rawOutput,
              locations: partial.locations,
              content: partial.content,
            },
          },
        ]
      })
    }
    case 'plan': {
      const rawEntries = Array.isArray(update.entries) ? update.entries : []
      const entries: AcpPlanEntry[] = rawEntries.flatMap(e => {
        if (!e || typeof e !== 'object') return []
        const { content, priority, status } = e as Record<string, unknown>
        if (typeof content !== 'string') return []
        return [
          {
            content,
            priority: (priority as AcpPlanEntry['priority']) ?? 'medium',
            status: (status as AcpPlanEntry['status']) ?? 'pending',
          },
        ]
      })
      if (entries.length === 0) return prev
      const list = ensureAssistant()
      return updateLastAssistantBlocks(list, blocks => {
        const idx = blocks.findIndex(b => b.kind === 'plan')
        if (idx >= 0) {
          const next = blocks.slice()
          next[idx] = { kind: 'plan', entries }
          return next
        }
        return [...blocks, { kind: 'plan', entries }]
      })
    }
    default:
      return prev
  }
}
