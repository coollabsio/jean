/**
 * Adds a last step to a magic prompt that is sent into the session: the agent
 * closes its own session through Jean MCP when the task succeeds. Without a
 * session id, the prompt does not change.
 */
export function withCloseSessionStep(
  prompt: string,
  closeSessionId?: string | null
): string {
  if (!closeSessionId) return prompt
  return `${prompt} When the task succeeds, as your last step, close this session with the Jean MCP \`delete_session\` tool (sessionId: "${closeSessionId}"). If the task fails, keep the session open.`
}
