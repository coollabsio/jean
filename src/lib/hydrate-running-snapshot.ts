import type { ChatMessage, ContentBlock, ToolCall } from '@/types/chat'
import { useChatStore } from '@/store/chat-store'
import { coalesceContentBlocks } from '@/components/chat/tool-call-utils'

function blocksOverlap(snapshot: ContentBlock, live: ContentBlock): boolean {
  if (snapshot.type !== live.type) return false

  switch (snapshot.type) {
    case 'text':
      return live.type === 'text' && snapshot.text.endsWith(live.text)
    case 'thinking':
      return (
        live.type === 'thinking' && snapshot.thinking.endsWith(live.thinking)
      )
    case 'tool_use':
      return (
        live.type === 'tool_use' && snapshot.tool_call_id === live.tool_call_id
      )
    case 'user_input':
      return live.type === 'user_input' && snapshot.text === live.text
  }
}

function blocksSharePrefix(
  full: ContentBlock[],
  prefix: ContentBlock[]
): boolean {
  if (prefix.length === 0 || full.length < prefix.length) return false

  return prefix.every((block, index) => {
    const candidate = full[index]
    if (!candidate || candidate.type !== block.type) return false

    switch (block.type) {
      case 'text':
        return (
          candidate.type === 'text' && candidate.text.startsWith(block.text)
        )
      case 'thinking':
        return (
          candidate.type === 'thinking' &&
          candidate.thinking.startsWith(block.thinking)
        )
      case 'tool_use':
        return (
          candidate.type === 'tool_use' &&
          candidate.tool_call_id === block.tool_call_id
        )
      case 'user_input':
        return candidate.type === 'user_input' && candidate.text === block.text
    }
  })
}

function mergeSnapshotBlocks(
  snapshot: ContentBlock[],
  liveWithSteers: ContentBlock[]
): ContentBlock[] {
  // Steered prompts can sit at a different place live than in the snapshot
  // (Claude shows a steer when the host accepts it, the run log records it
  // when the CLI consumes it). Compare both sides without steers so the order
  // difference does not break the merge. The snapshot keeps its steers; live
  // steers the snapshot does not have yet go at the end.
  const snapshotSteers = snapshot.flatMap(block =>
    block.type === 'user_input' ? [block.text] : []
  )
  const pendingSteers: ContentBlock[] = []
  const live = liveWithSteers.filter(block => {
    if (block.type !== 'user_input') return true
    const index = snapshotSteers.indexOf(block.text)
    if (index >= 0) snapshotSteers.splice(index, 1)
    else pendingSteers.push(block)
    return false
  })
  const snapshotCore = snapshot.filter(block => block.type !== 'user_input')

  // A refreshed snapshot and the live stream often share their beginning.
  // Keep the longer sequence instead of appending the shorter one twice.
  if (blocksSharePrefix(snapshotCore, live)) {
    return [...snapshot, ...pendingSteers]
  }
  if (blocksSharePrefix(live, snapshotCore)) {
    // Live extends the snapshot: take the (possibly longer) live version of
    // the last snapshot block, then the live blocks after it.
    const lastCore = snapshot.lastIndexOf(snapshotCore.at(-1) as ContentBlock)
    return [
      ...snapshot.slice(0, lastCore),
      ...live.slice(snapshotCore.length - 1, snapshotCore.length),
      ...snapshot.slice(lastCore + 1),
      ...live.slice(snapshotCore.length),
      ...pendingSteers,
    ]
  }

  const maxOverlap = Math.min(snapshotCore.length, live.length)
  let overlap = 0

  for (let size = maxOverlap; size > 0; size--) {
    const snapshotStart = snapshotCore.length - size
    const matches = live.slice(0, size).every((block, index) => {
      const snapshotBlock = snapshotCore[snapshotStart + index]
      return snapshotBlock ? blocksOverlap(snapshotBlock, block) : false
    })
    if (matches) {
      overlap = size
      break
    }
  }

  return [
    ...coalesceContentBlocks([...snapshot, ...live.slice(overlap)]),
    ...pendingSteers,
  ]
}

function mergeSnapshotToolCalls(
  snapshot: ToolCall[],
  live: ToolCall[]
): ToolCall[] {
  const liveById = new Map(live.map(tool => [tool.id, tool]))
  const merged = snapshot.map(tool => {
    const liveTool = liveById.get(tool.id)
    if (!liveTool) return tool
    liveById.delete(tool.id)
    return {
      ...tool,
      ...liveTool,
      input: liveTool.input ?? tool.input,
      output: liveTool.output ?? tool.output,
      events: liveTool.events ?? tool.events,
    }
  })

  return [...merged, ...live.filter(tool => liveById.has(tool.id))]
}

/**
 * Rebuild `streamingContentBlocks` for a running assistant snapshot so the
 * reopened view matches what live streaming would produce.
 *
 * Backend `parse_run_to_message` emits one `ContentBlock::Text` per Claude CLI
 * stream-json delta. Live streaming merges those via `addTextBlock`, but a
 * snapshot loaded from disk or delivered to a web-access client arrives with
 * the deltas still split. Route them through the same invariant here.
 *
 * Safe to call from any session-open path — reloads, web access click-to-open,
 * sidebar navigation. Snapshot state is merged ahead of live events that may
 * have arrived while the reload bootstrap was still fetching session data.
 */
export function hydrateRunningSnapshot(
  sessionId: string,
  lastMsg: ChatMessage,
  options: { allowWhileSending?: boolean; dedupeReplayedOutput?: boolean } = {}
): void {
  const store = useChatStore.getState()
  // Live streaming never adds empty text/thinking blocks. Drop them here so
  // the snapshot and live blocks line up and merge without duplicates.
  const normalized = coalesceContentBlocks(
    (lastMsg.content_blocks ?? []).filter(
      block =>
        !(block.type === 'thinking' && !block.thinking) &&
        !(block.type === 'text' && !block.text)
    )
  )
  if (options.dedupeReplayedOutput) {
    store.setStreamingReplayContentBlocks(sessionId, normalized)
  }
  // Defense in depth: never hydrate while this client is mid-send unless the
  // bootstrap path explicitly opts in.
  // Note: streamingContents is NOT checked here because App.tsx auto-resume
  // intentionally seeds it before calling hydrate.
  if (!options.allowWhileSending && store.sendingSessionIds[sessionId]) return

  useChatStore.setState(state => {
    // Live tool calls that are missing from the running snapshot and already
    // answered belong to an earlier paused turn (question/plan kept by
    // pauseSession). Drop them so they do not resurface in this turn (#779).
    const snapshotToolIds = new Set((lastMsg.tool_calls ?? []).map(t => t.id))
    const answered = state.answeredQuestions[sessionId]
    const isStale = (toolId: string) =>
      !snapshotToolIds.has(toolId) && (answered?.has(toolId) ?? false)
    const liveToolCalls = (state.activeToolCalls[sessionId] ?? []).filter(
      tool => !isStale(tool.id)
    )
    const liveBlocks = (state.streamingContentBlocks[sessionId] ?? []).filter(
      block => block.type !== 'tool_use' || !isStale(block.tool_call_id)
    )

    return {
      streamingContentBlocks: {
        ...state.streamingContentBlocks,
        [sessionId]: mergeSnapshotBlocks(normalized, liveBlocks),
      },
      activeToolCalls: {
        ...state.activeToolCalls,
        [sessionId]: mergeSnapshotToolCalls(
          lastMsg.tool_calls ?? [],
          liveToolCalls
        ),
      },
    }
  })
}
