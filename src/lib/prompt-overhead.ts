/**
 * Estimate how many input tokens Jean adds to every backend request.
 *
 * Jean prepends its own system prompt blocks and MCP tool schemas to each run,
 * so the cost is paid per request, on every turn, and again inside every
 * sub-agent. This module turns the currently enabled preferences into a rough
 * token figure so the settings pane can show what a toggle actually costs.
 *
 * Blocks that live only in Rust are measured constants; blocks mirrored in
 * `src/types/preferences.ts` are measured from the live string so a prompt edit
 * moves the number.
 */

import {
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
  DEFAULT_LEAN_GLOBAL_SYSTEM_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  NO_SUBAGENT_INSTRUCTION,
} from '../types/preferences'

/** Rough tokenizer stand-in. Good enough for a settings-pane estimate. */
const CHARS_PER_TOKEN = 4

/**
 * Serialized size of the Jean MCP tool registry (`tool_registry_core` +
 * `tool_registry_session` + `tool_registry_ship_loop` in
 * `jean-core/src/jean_mcp_core.rs`).
 */
const JEAN_MCP_TOOL_SCHEMA_CHARS = 20396

/** `RECAP_INSTRUCTION` in `jean-core/src/chat/mod.rs`. */
const RECAP_INSTRUCTION_CHARS = 2067

/**
 * Execution-mode instruction plus the embedded gh/claude/codex binary-path
 * lines. Always sent; there is no toggle for them.
 */
const RUN_INSTRUCTION_CHARS = 800

export interface PromptOverheadInput {
  quotaSaverEnabled: boolean
  parallelExecutionPromptEnabled: boolean
  autoRecapsEnabled: boolean
  jeanMcpEnabled: boolean
  /** Custom override from Magic Prompts, or null to use the built-in default. */
  globalSystemPrompt?: string | null
  /** Custom override from Magic Prompts, or null to use the built-in default. */
  parallelExecutionPrompt?: string | null
}

export interface PromptOverheadRow {
  label: string
  tokens: number
}

export interface PromptOverheadEstimate {
  totalTokens: number
  rows: PromptOverheadRow[]
}

function toTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN)
}

function resolvePrompt(
  custom: string | null | undefined,
  fallback: string
): string {
  const trimmed = custom?.trim()
  return trimmed ? trimmed : fallback
}

/**
 * Estimate Jean's per-request system prompt overhead, broken down by block.
 * Rows with zero tokens are omitted. Excludes the `~/.claude/skills` and
 * `~/.claude/commands` listing, which varies per machine — Quota Saver drops
 * that too, so the real saving is larger than the number reported here.
 */
export function estimatePromptOverhead(
  input: PromptOverheadInput
): PromptOverheadEstimate {
  const {
    quotaSaverEnabled,
    parallelExecutionPromptEnabled,
    autoRecapsEnabled,
    jeanMcpEnabled,
    globalSystemPrompt,
    parallelExecutionPrompt,
  } = input

  const fanOutEnabled = parallelExecutionPromptEnabled && !quotaSaverEnabled

  const globalPrompt = resolvePrompt(
    globalSystemPrompt,
    quotaSaverEnabled
      ? DEFAULT_LEAN_GLOBAL_SYSTEM_PROMPT
      : DEFAULT_GLOBAL_SYSTEM_PROMPT
  )

  const rows: PromptOverheadRow[] = [
    {
      label: 'Jean MCP tool schemas',
      tokens:
        jeanMcpEnabled && !quotaSaverEnabled
          ? toTokens(JEAN_MCP_TOOL_SCHEMA_CHARS)
          : 0,
    },
    {
      label: quotaSaverEnabled ? 'Global prompt (lean)' : 'Global prompt',
      tokens: toTokens(globalPrompt.length),
    },
    {
      label: fanOutEnabled ? 'Sub-agent fan-out prompt' : 'Sub-agent policy',
      tokens: toTokens(
        fanOutEnabled
          ? resolvePrompt(
              parallelExecutionPrompt,
              DEFAULT_PARALLEL_EXECUTION_PROMPT
            ).length
          : NO_SUBAGENT_INSTRUCTION.length
      ),
    },
    {
      label: 'Recap instruction',
      tokens:
        autoRecapsEnabled && !quotaSaverEnabled
          ? toTokens(RECAP_INSTRUCTION_CHARS)
          : 0,
    },
    {
      label: 'Run instructions',
      tokens: toTokens(RUN_INSTRUCTION_CHARS),
    },
  ].filter(row => row.tokens > 0)

  return {
    totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    rows,
  }
}

/** `7600` → `"~7,600"`. */
export function formatOverheadTokens(tokens: number): string {
  return `~${tokens.toLocaleString('en-US')}`
}
