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

function mergeSnapshotBlocks(
  snapshot: ContentBlock[],
  live: ContentBlock[]
): ContentBlock[] {
  const maxOverlap = Math.min(snapshot.length, live.length)
  let overlap = 0

  for (let size = maxOverlap; size > 0; size--) {
    const snapshotStart = snapshot.length - size
    const matches = live.slice(0, size).every((block, index) => {
      const snapshotBlock = snapshot[snapshotStart + index]
      return snapshotBlock ? blocksOverlap(snapshotBlock, block) : false
    })
    if (matches) {
      overlap = size
      break
    }
  }

  return coalesceContentBlocks([...snapshot, ...live.slice(overlap)])
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
  const normalized = coalesceContentBlocks(lastMsg.content_blocks ?? [])
  if (options.dedupeReplayedOutput) {
    store.setStreamingReplayContentBlocks(sessionId, normalized)
  }
  // Defense in depth: never hydrate while this client is mid-send unless the
  // bootstrap path explicitly opts in.
  // Note: streamingContents is NOT checked here because App.tsx auto-resume
  // intentionally seeds it before calling hydrate.
  if (!options.allowWhileSending && store.sendingSessionIds[sessionId]) return

  useChatStore.setState(state => ({
    streamingContentBlocks: {
      ...state.streamingContentBlocks,
      [sessionId]: mergeSnapshotBlocks(
        normalized,
        state.streamingContentBlocks[sessionId] ?? []
      ),
    },
    activeToolCalls: {
      ...state.activeToolCalls,
      [sessionId]: mergeSnapshotToolCalls(
        lastMsg.tool_calls ?? [],
        state.activeToolCalls[sessionId] ?? []
      ),
    },
  }))
}
