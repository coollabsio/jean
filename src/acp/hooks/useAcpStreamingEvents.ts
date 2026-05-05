import { useEffect } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { listen } from '@/lib/transport'
import type { AcpEventPayload, AcpPermissionPayload } from '../api/api'
import {
  parseAvailableCommands,
  parseSemanticSelectConfigOption,
  parseToolCallFields,
  parseUsagePatch,
  useAcpStore,
  type AcpModeInfo,
  type AcpModelInfo,
  type AcpPermissionOption,
  type AcpPlanEntry,
  type AcpThoughtLevelInfo,
} from '../store/acp-store'

/**
 * App-wide singleton subscriber for the `acp:event` Tauri channel. Mounted
 * exactly once from `App.tsx`.
 *
 * Mirrors `src/components/chat/hooks/useStreamingEvents.ts`:
 *   - One global `listen()` registration for the entire app lifetime so the
 *     listener survives every component remount and tab switch.
 *   - Per-chunk deltas (`agent_message_chunk`, `agent_thought_chunk`) are
 *     coalesced into per-session buffers and flushed once per
 *     `requestAnimationFrame`. Without batching, a fast stream produces a
 *     Zustand `set` per chunk → a re-render per chunk; with batching, N
 *     chunks in a single frame collapse into one update.
 *   - Chunks land in **Zustand** (`acp-store`'s `streamingText` /
 *     `streamingThinking` / `streamingToolCalls`), not in TanStack Query.
 *     The RQ cache is reserved for the cold disk-load fetch only —
 *     `useAcpStore` is the single source of truth for live state.
 *
 * Routing is by stable `jean_session_id`, stamped on the payload by the
 * backend. Early notifications that arrive before log registration are
 * buffered server-side and re-emitted after binding, so the frontend can
 * rely on this id for session routing.
 */
export function useAcpStreamingEvents({
  queryClient: _queryClient,
}: {
  // Threaded through for parity with `useStreamingEvents`. Currently unused
  // — live events go to Zustand, not RQ — but kept in the signature so
  // callers don't have to change shape if we later need to invalidate
  // related queries (session listings etc.) on certain notifications.
  queryClient: QueryClient
}) {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    listen<AcpEventPayload>('acp:event', e => {
      const sid = e.payload.jean_session_id
      if (!sid) return
      const frame = e.payload.frame as Record<string, unknown> | undefined
      if (!frame) return

      // Usage updates ride on both the streaming SessionUpdate channel and
      // the `session/prompt` response envelope — `parseUsagePatch` handles
      // both shapes. Apply unconditionally (idempotent guard inside the
      // store) before falling through to the SessionUpdate switch.
      const usagePatch = parseUsagePatch(frame)
      if (usagePatch) useAcpStore.getState().applyUsageUpdate(sid, usagePatch)

      const update = (frame.update ?? {}) as Record<string, unknown>
      const kind = update.sessionUpdate as string | undefined
      if (!kind) return

      // NB: chunks are applied synchronously (no rAF batching). The store
      // maintains a single ordered timeline of blocks per turn, and a
      // tool call landing between two text chunks must split them into
      // two text blocks — coalescing chunks across a frame boundary
      // before draining would let a tool that arrived mid-frame slot in
      // *after* both halves of text, losing the narration order.
      switch (kind) {
        case 'agent_message_chunk': {
          const content = (update.content ?? {}) as {
            type?: string
            text?: string
          }
          if (content.type !== 'text' || !content.text) return
          useAcpStore.getState().appendStreamingText(sid, content.text)
          return
        }
        case 'agent_thought_chunk': {
          const content = (update.content ?? {}) as {
            type?: string
            text?: string
          }
          if (content.type !== 'text' || !content.text) return
          useAcpStore.getState().appendStreamingThinking(sid, content.text)
          return
        }
        case 'tool_call':
        case 'tool_call_update': {
          const id = (update.toolCallId as string | undefined) ?? ''
          if (!id) return
          const partial = parseToolCallFields(update, id)
          useAcpStore.getState().upsertStreamingToolCall(sid, partial)
          return
        }
        case 'config_option_update': {
          // ACP's canonical source of truth is `configOptions`. Agents
          // return the full config state on every change specifically so
          // dependent selectors can change together. We project that full
          // state into our three UX pickers (model, mode, thought level) while
          // preserving the actual `configId` for correctness on writes.
          const opts = update.configOptions
          const store = useAcpStore.getState()
          const model = parseSemanticSelectConfigOption<AcpModelInfo>(
            opts,
            'model'
          )
          if (model) {
            store.setSessionModels(
              sid,
              model.currentId,
              model.available,
              model.configId
            )
          }
          const mode = parseSemanticSelectConfigOption<AcpModeInfo>(
            opts,
            'mode'
          )
          if (mode) {
            store.setSessionModes(
              sid,
              mode.currentId,
              mode.available,
              mode.configId
            )
          }
          const thoughtLevel =
            parseSemanticSelectConfigOption<AcpThoughtLevelInfo>(
              opts,
              'thought_level'
            )
          if (thoughtLevel) {
            store.setSessionThoughtLevels(
              sid,
              thoughtLevel.currentId,
              thoughtLevel.available,
              thoughtLevel.configId
            )
          } else if (Array.isArray(opts)) {
            // The agent sent a fresh configOptions list with no thought-level
            // selector — the current model doesn't expose one. Clear the
            // slice so the picker hides instead of showing stale options.
            store.setSessionThoughtLevels(sid, '', [], '')
          }
          return
        }
        case 'plan': {
          // Full snapshot — replace wholesale per spec. Parse entries
          // defensively; malformed entries are dropped.
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
          if (entries.length > 0) {
            useAcpStore.getState().upsertStreamingPlan(sid, entries)
          }
          return
        }
        case 'current_mode_update': {
          // Spec-defined notification: agent self-switches modes (e.g.
          // claude-agent-acp auto-exits plan mode after the plan is
          // approved). Some adapters emit only this; others piggyback on
          // `config_option_update`. Handle both so we stay truthful no
          // matter which form the adapter chose.
          const modeId = update.currentModeId
          if (typeof modeId === 'string' && modeId) {
            useAcpStore.getState().setCurrentModeId(sid, modeId)
          }
          return
        }
        case 'session_info_update': {
          // Spec stabilized 2026-03-09: agents can push a generated title
          // (and updatedAt) for the session. Per spec semantics, `null`
          // explicitly clears the title; an absent `title` field means
          // "no change" and is left alone here. The backend persists the
          // title to snapshot.json in parallel; this slice is the
          // live-UI mirror.
          if ('title' in update) {
            const t = update.title
            if (t === null) {
              useAcpStore.getState().setSessionTitle(sid, null)
            } else if (typeof t === 'string') {
              useAcpStore.getState().setSessionTitle(sid, t)
            }
          }
          return
        }
        case 'available_commands_update': {
          // Agent always sends a full snapshot of the command catalog —
          // never a delta — so we replace wholesale. An empty array is a
          // valid payload (means "no commands available") and is
          // forwarded as-is so the popover hides cleanly.
          const commands = parseAvailableCommands(update)
          if (commands) useAcpStore.getState().setSessionCommands(sid, commands)
          return
        }
        default:
          return
      }
    }).then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })

    // Permission requests are a separate Tauri event channel — not a
    // SessionNotification — because they're a JSON-RPC *request* the
    // backend has to park on. Routed by jean_session_id like everything
    // else; null sid means the request fired before a log was registered
    // (shouldn't happen) and is dropped.
    let unlistenPerm: (() => void) | undefined
    listen<AcpPermissionPayload>('acp:permission', e => {
      const sid = e.payload.jean_session_id
      if (!sid) return
      const req = e.payload.request as Record<string, unknown> | undefined
      const tool = (req?.toolCall ?? {}) as Record<string, unknown>
      const rawOptions = Array.isArray(req?.options) ? req.options : []
      const options: AcpPermissionOption[] = []
      for (const o of rawOptions) {
        if (!o || typeof o !== 'object') continue
        const item = o as Record<string, unknown>
        const optionId = item.optionId
        const name = item.name
        if (typeof optionId !== 'string' || !optionId) continue
        if (typeof name !== 'string' || !name) continue
        const kind = typeof item.kind === 'string' ? item.kind : undefined
        options.push({ optionId, name, kind })
      }
      if (options.length === 0) return

      useAcpStore.getState().addPendingPermission(sid, {
        requestId: e.payload.request_id,
        toolTitle: typeof tool.title === 'string' ? tool.title : undefined,
        toolKind: typeof tool.kind === 'string' ? tool.kind : undefined,
        description:
          typeof req?.description === 'string'
            ? (req.description as string)
            : undefined,
        options,
      })
    }).then(fn => {
      if (cancelled) fn()
      else unlistenPerm = fn
    })

    return () => {
      cancelled = true
      unlisten?.()
      unlistenPerm?.()
    }
    // queryClient is stable for the lifetime of QueryClientProvider; no
    // other deps in the closure that could shift identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
