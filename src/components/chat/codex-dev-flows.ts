import type { CodexUserInputRequest } from '@/types/chat'

/**
 * Schema source:
 * - codex-schema/ToolRequestUserInputParams.json
 * - codex-schema/ToolRequestUserInputResponse.json
 */
interface ToolRequestUserInputOptionSchema {
  label: string
  description: string
}

interface ToolRequestUserInputQuestionSchema {
  header: string
  id: string
  question: string
  options?: ToolRequestUserInputOptionSchema[] | null
  isOther?: boolean
  isSecret?: boolean
}

interface ToolRequestUserInputParamsSchema {
  itemId: string
  threadId: string
  turnId: string
  questions: ToolRequestUserInputQuestionSchema[]
}

export interface CodexDevFlowDefinition {
  id: string
  label: string
  description: string
  payload: ToolRequestUserInputParamsSchema
}

export interface CodexDevPromptDefinition {
  id: string
  label: string
  description: string
  prompt: string
}

export const CODEX_DEV_FLOWS: CodexDevFlowDefinition[] = [
  {
    id: 'tool-request-user-input-options',
    label: 'Options only',
    description: 'Basic options from ToolRequestUserInputParams',
    payload: {
      itemId: 'dev-tool-request-user-input-options',
      threadId: 'dev-thread',
      turnId: 'dev-turn-options',
      questions: [
        {
          header: 'Framework',
          id: 'framework',
          question: 'Which framework should Jean optimize for?',
          options: [
            {
              label: 'React',
              description: 'Keep the current React-first workflow',
            },
            {
              label: 'Vue',
              description: 'Validate cross-framework rendering assumptions',
            },
          ],
          isOther: false,
          isSecret: false,
        },
      ],
    },
  },
  {
    id: 'tool-request-user-input-other',
    label: 'Options + other',
    description: 'Option list plus free-form answer',
    payload: {
      itemId: 'dev-tool-request-user-input-other',
      threadId: 'dev-thread',
      turnId: 'dev-turn-other',
      questions: [
        {
          header: 'Priority',
          id: 'priority',
          question: 'What should I optimize next?',
          options: [
            {
              label: 'Speed',
              description: 'Faster iteration and less friction',
            },
            {
              label: 'Safety',
              description: 'Prefer guardrails and validation',
            },
          ],
          isOther: true,
          isSecret: false,
        },
      ],
    },
  },
  {
    id: 'tool-request-user-input-secret',
    label: 'Secret input',
    description: 'Free-form secret answer rendered as password input',
    payload: {
      itemId: 'dev-tool-request-user-input-secret',
      threadId: 'dev-thread',
      turnId: 'dev-turn-secret',
      questions: [
        {
          header: 'Credential',
          id: 'token',
          question: 'Paste a fake token to verify masked input',
          options: [],
          isOther: true,
          isSecret: true,
        },
      ],
    },
  },
]

export const CODEX_DEV_PROMPTS: CodexDevPromptDefinition[] = [
  {
    id: 'ask-followup-questions',
    label: 'Ask follow-ups',
    description: 'Prompt Codex to ask structured follow-up questions first',
    prompt:
      'Before doing any work, ask me 2 short follow-up multiple-choice questions using your user input tool, then wait for my answers.',
  },
  {
    id: 'ask-secret-and-other',
    label: 'Ask secret + other',
    description:
      'Prompt Codex to ask for a masked value and a free-form answer',
    prompt:
      'Use your user input tool to ask me two questions: first a secret token field, then a multiple-choice question that also allows an Other free-text answer. Wait for my answers before continuing.',
  },
  {
    id: 'ask-decision-tree',
    label: 'Ask decision tree',
    description: 'Prompt Codex to collect preferences before planning',
    prompt:
      'Ask me 3 short user-input questions before you plan: framework preference, risk tolerance, and whether to prioritize speed or correctness. Use structured options and then stop for input.',
  },
]

export function buildCodexDevUserInputRequest(
  flow: CodexDevFlowDefinition
): CodexUserInputRequest {
  return {
    rpc_id: -Date.now(),
    item_id: flow.payload.itemId,
    thread_id: flow.payload.threadId,
    turn_id: flow.payload.turnId,
    questions: flow.payload.questions,
  }
}

export function isCodexDevUserInputRequest(
  request: Pick<CodexUserInputRequest, 'rpc_id' | 'item_id'>
): boolean {
  return request.rpc_id < 0 || request.item_id.startsWith('dev-tool-request-')
}
