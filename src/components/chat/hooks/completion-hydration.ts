import type { ContentBlock, ToolCall } from '@/types/chat'
import { splitTextAroundPlan } from '../tool-call-utils'

export function hasMeaningfulAssistantPayload(
  content: string,
  contentBlocks: ContentBlock[] = [],
  toolCalls: ToolCall[] = []
): boolean {
  if (content.trim().length > 0) return true
  if (toolCalls.length > 0) return true

  return contentBlocks.some(block => {
    switch (block.type) {
      case 'text':
        return block.text.trim().length > 0
      case 'thinking':
        return block.thinking.trim().length > 0
      case 'tool_use':
        return block.tool_call_id.trim().length > 0
    }
  })
}

const PLAN_TOOL_NAMES = new Set(['CodexPlan', 'ExitPlanMode'])

/**
 * Detect Grok-style space loss: word fragments were concatenated without the
 * leading spaces Grok usually puts on each delta (e.g. "bun"+" run" → "bunrun").
 * Used to force backend re-hydration so the NDJSON parse (which keeps spaces)
 * replaces a permanently glued optimistic assistant message.
 */
export function looksLikeCollapsedStreamSpaces(content: string): boolean {
  if (!content) return false
  // Common glued tokens from the Grok ACP stream + markdown fences.
  if (
    /bashbun|bunrun|Testfirst|##Recap|orImages|andthematching|Oneinvoice/i.test(
      content
    )
  ) {
    return true
  }
  // Letter-letter joins across what should be word boundaries after `:` or
  // code-ish tokens without spaces (invoice:in is fine; invoices----v2 is not).
  if (/[a-z]{3,}[A-Z][a-z]{2,}/.test(content) && !/\s/.test(content.slice(0, 80))) {
    return true
  }
  return false
}

export function shouldHydrateCompletedSessionFromBackend(
  content: string,
  contentBlocks: ContentBlock[] = [],
  toolCalls: ToolCall[] = [],
  options?: { backend?: string | null; force?: boolean }
): boolean {
  if (options?.force) return true

  // Always hydrate after a plan tool: chat:done adds an optimistic assistant
  // message with a frontend-generated id, which can race past useSendMessage
  // onSuccess and leave the cache holding an id that doesn't match the
  // backend's NDJSON id. mark_plan_approved keys on that id, so without
  // hydration the approval never sticks and the plan dialog re-shows.
  const hasPlanTool = toolCalls.some(tc => PLAN_TOOL_NAMES.has(tc.name))
  if (hasPlanTool) return true

  // No plan tool emitted, but text contains a plan section → hydrate so the
  // backend can re-parse and persist a structured plan.
  if (splitTextAroundPlan(content).plan) {
    return true
  }

  // Grok ACP streams word fragments with leading spaces. If the optimistic
  // UI text lost those spaces, replace it with the run-log parse (known good).
  if (
    options?.backend === 'grok' ||
    looksLikeCollapsedStreamSpaces(content) ||
    contentBlocks.some(
      block => block.type === 'text' && looksLikeCollapsedStreamSpaces(block.text)
    )
  ) {
    return true
  }

  return !hasMeaningfulAssistantPayload(content, contentBlocks, toolCalls)
}
